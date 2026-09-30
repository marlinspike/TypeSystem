import { performance } from "node:perf_hooks";
import { EncryptionConfigError, KeyUnavailableError } from "./errors.js";
import { checkKeyId, KEY_BYTES, keyBytes, keyringFromEnv, masterKey, type Keyring, type KeyProvider, type MasterKey } from "./keys.js";

/**
 * A key in a KMS that wraps data keys (ADR-0037) — `AwsKmsKey` in
 * `@typesys/kms-aws`. Every wrap is bound to the data key's id, so a
 * wrapped key can't be relabeled as another.
 */
export interface KeyEncryptionKey {
  /** Names the KMS key in errors — e.g. `aws-kms:alias/typesys` — and is never secret. */
  readonly name: string;
  /** A new data key of `KEY_BYTES` bytes for `keyId`, wrapped; its plaintext stays in the KMS. */
  generateWrappedKey(keyId: string): Promise<Uint8Array>;
  /** The data key `wrapped` holds; rejects if it was wrapped by another KMS key or for another id, or access is denied. */
  unwrap(wrapped: Uint8Array, keyId: string): Promise<Uint8Array>;
}

/** A new keyring entry for `keyId`: the data key, wrapped, as base64. Only the KMS ever sees its plaintext. */
export async function newWrappedKey(kek: KeyEncryptionKey, keyId: string): Promise<string> {
  checkKeyId(keyId);
  return Buffer.from(await kek.generateWrappedKey(keyId)).toString("base64");
}

/** How long unwrapped keys are trusted (ADR-0037). */
export interface WrappedKeyOptions {
  /** After this long, the next use re-unwraps the ring in the background. Default 5 minutes. */
  refreshAfterMs?: number;
  /** After this long without a successful refresh, keys are unusable until one succeeds. Default 15 minutes. */
  maxKeyAgeMs?: number;
  /** The least time between two refresh attempts, so an outage isn't one KMS call per request. Default 30 seconds. */
  retryIntervalMs?: number;
  /** Called once for every failed refresh. Defaults to `console.warn`. */
  onRefreshError?: (err: KeyUnavailableError) => void;
  /** A monotonic clock in milliseconds. Defaults to `performance.now`. */
  now?: () => number;
}

interface Unwrapped {
  readonly keys: ReadonlyMap<string, MasterKey>;
  readonly active: MasterKey;
  /** When the unwrap that produced these keys began: the lease runs from here. */
  readonly at: number;
}

function duration(name: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0)) throw new EncryptionConfigError(`${name} must be a positive number of milliseconds`);
  return value;
}

/**
 * A keyring of data keys wrapped by a KMS key (ADR-0037). `open()` unwraps
 * every key or rejects, so a process that can't reach its keys never
 * starts. Unwrapped keys are then leased: refreshed in the background after
 * `refreshAfterMs`, kept through a failed refresh, and refused once
 * `maxKeyAgeMs` passes without a successful one — so revoking the KMS key
 * stops every instance within that time.
 */
export class WrappedKeyProvider implements KeyProvider {
  private readonly refreshAfterMs: number;
  private readonly maxKeyAgeMs: number;
  private readonly retryIntervalMs: number;
  private readonly onRefreshError: (err: KeyUnavailableError) => void;
  private readonly now: () => number;
  private ring!: Unwrapped;
  private refreshing: Promise<Unwrapped> | undefined;
  private failure: { at: number; error: KeyUnavailableError } | undefined;

  private constructor(
    private readonly kek: KeyEncryptionKey,
    private readonly wrapped: ReadonlyMap<string, Buffer>,
    private readonly activeId: string,
    options: WrappedKeyOptions
  ) {
    this.refreshAfterMs = duration("refreshAfterMs", options.refreshAfterMs ?? 5 * 60_000);
    this.maxKeyAgeMs = duration("maxKeyAgeMs", options.maxKeyAgeMs ?? 15 * 60_000);
    this.retryIntervalMs = duration("retryIntervalMs", options.retryIntervalMs ?? 30_000);
    if (this.refreshAfterMs >= this.maxKeyAgeMs) throw new EncryptionConfigError("refreshAfterMs must be less than maxKeyAgeMs");
    this.onRefreshError = options.onRefreshError ?? ((err) => console.warn(`WrappedKeyProvider: ${err.message}; keeping the current keys`));
    this.now = options.now ?? (() => performance.now());
  }

  /** Unwraps every key in `keyring` through `kek`, or rejects with `KeyUnavailableError`. */
  static async open(kek: KeyEncryptionKey, keyring: Keyring, options: WrappedKeyOptions = {}): Promise<WrappedKeyProvider> {
    const wrapped = new Map(
      Object.entries(keyring.keys).map(([id, material]) => {
        checkKeyId(id);
        return [id, keyBytes(id, material)] as const;
      })
    );
    if (!wrapped.has(keyring.active)) throw new EncryptionConfigError(`The active key "${keyring.active}" is not in the keyring`);
    const provider = new WrappedKeyProvider(kek, wrapped, keyring.active, options);
    provider.ring = await provider.unwrapAll();
    return provider;
  }

  /** `open()` over a keyring of wrapped keys in an environment variable — `id:base64` pairs, the active key first. */
  static fromEnv(
    kek: KeyEncryptionKey,
    env: Record<string, string | undefined> = process.env,
    variable = "TYPESYS_WRAPPED_KEYS",
    options: WrappedKeyOptions = {}
  ): Promise<WrappedKeyProvider> {
    return WrappedKeyProvider.open(kek, keyringFromEnv(env, variable), options);
  }

  private async unwrapAll(): Promise<Unwrapped> {
    const at = this.now();
    const keys = await Promise.all(
      [...this.wrapped].map(async ([id, blob]) => {
        let material: Uint8Array;
        try {
          material = await this.kek.unwrap(blob, id);
        } catch (err) {
          throw new KeyUnavailableError(`Key "${id}" could not be unwrapped by ${this.kek.name}`, { cause: err });
        }
        try {
          return masterKey(id, material);
        } catch {
          throw new KeyUnavailableError(`Key "${id}" unwrapped by ${this.kek.name} is not a ${KEY_BYTES}-byte key`);
        }
      })
    );
    const byId = new Map(keys.map((key) => [key.id, key]));
    return { keys: byId, active: byId.get(this.activeId)!, at };
  }

  /** One refresh, shared by every caller while it runs; `undefined` if the last one failed less than `retryIntervalMs` ago. */
  private attempt(): Promise<Unwrapped> | undefined {
    if (this.refreshing) return this.refreshing;
    if (this.failure && this.now() - this.failure.at < this.retryIntervalMs) return undefined;
    const attempt = this.unwrapAll()
      .then(
        (ring) => {
          this.ring = ring;
          this.failure = undefined;
          return ring;
        },
        (error: KeyUnavailableError) => {
          this.failure = { at: this.now(), error };
          this.onRefreshError(error);
          throw error;
        }
      )
      .finally(() => {
        this.refreshing = undefined;
      });
    // A background refresh has no caller awaiting it, and its failure is already reported.
    attempt.catch(() => undefined);
    this.refreshing = attempt;
    return attempt;
  }

  /** The keys the lease still allows, refreshing them first if it has run out. */
  private async current(): Promise<Unwrapped> {
    const age = this.now() - this.ring.at;
    if (age < this.refreshAfterMs) return this.ring;
    if (age < this.maxKeyAgeMs) {
      void this.attempt();
      return this.ring;
    }
    const expired = `The keys unwrapped by ${this.kek.name} are past maxKeyAgeMs and could not be refreshed`;
    const attempt = this.attempt();
    if (!attempt) throw new KeyUnavailableError(expired, { cause: this.failure?.error });
    try {
      return await attempt;
    } catch (err) {
      throw new KeyUnavailableError(expired, { cause: err });
    }
  }

  async activeKey(): Promise<MasterKey> {
    return (await this.current()).active;
  }

  async keyById(id: string): Promise<MasterKey | undefined> {
    return (await this.current()).keys.get(id);
  }

  async allKeys(): Promise<MasterKey[]> {
    const { keys, active } = await this.current();
    return [active, ...[...keys.values()].filter((k) => k !== active)];
  }
}
