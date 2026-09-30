import { EncryptionConfigError } from "./errors.js";

/** 32 bytes of master key material and the stable id every envelope written under it names. */
export interface MasterKey {
  readonly id: string;
  readonly material: Uint8Array;
}

/**
 * Where keys come from (ADR-0033). The adapter never sees key
 * configuration, only these three answers. `LocalKeyProvider` holds a
 * keyring in memory; `WrappedKeyProvider` (ADR-0037) holds data keys
 * wrapped by a KMS key and unwraps them on a lease.
 */
export interface KeyProvider {
  /** The key new values are encrypted, and their blind indexes computed, under. */
  activeKey(): Promise<MasterKey>;
  /** The key a stored envelope names — active or retired. `undefined` for a key no longer held, which fails the read closed. */
  keyById(id: string): Promise<MasterKey | undefined>;
  /** Every key a stored blind index may have been computed under, active first, so equality lookups span a rotation. */
  allKeys(): Promise<MasterKey[]>;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const KEY_BYTES = 32;

/** A keyring as configured: key id to material (raw, or wrapped), and the active id. */
export interface Keyring {
  keys: Record<string, string | Uint8Array>;
  active: string;
}

export function checkKeyId(id: string): void {
  if (!KEY_ID.test(id)) throw new EncryptionConfigError(`Key id "${id}" must be 1–64 characters of [A-Za-z0-9_-]`);
}

/** Base64 or raw bytes, as a Buffer. */
export function keyBytes(id: string, material: string | Uint8Array): Buffer {
  if (typeof material === "string" && !BASE64.test(material)) throw new EncryptionConfigError(`Key "${id}" is not base64`);
  return typeof material === "string" ? Buffer.from(material, "base64") : Buffer.from(material);
}

export function masterKey(id: string, material: string | Uint8Array): MasterKey {
  checkKeyId(id);
  const bytes = keyBytes(id, material);
  if (bytes.length !== KEY_BYTES) throw new EncryptionConfigError(`Key "${id}" must be ${KEY_BYTES} bytes, got ${bytes.length}`);
  return { id, material: bytes };
}

/** A keyring from an environment variable of `id:base64` pairs separated by commas, the active key first. */
export function keyringFromEnv(env: Record<string, string | undefined>, variable: string): Keyring {
  const spec = env[variable]?.trim();
  if (!spec) throw new EncryptionConfigError(`${variable} is not set`);
  const pairs = spec.split(",").map((pair) => {
    const separator = pair.indexOf(":");
    if (separator < 1) throw new EncryptionConfigError(`${variable} entries must be id:base64`);
    return [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()] as const;
  });
  if (new Set(pairs.map(([id]) => id)).size !== pairs.length) throw new EncryptionConfigError(`${variable} names a key id twice`);
  return { keys: Object.fromEntries(pairs), active: pairs[0]![0] };
}

/**
 * An in-memory keyring: every key a stored value may name, one of them
 * active. Rotating is adding a new key and making it active; the old one
 * stays until nothing is stored under it. Keys are base64 strings (e.g.
 * `openssl rand -base64 32`) or raw bytes. A development convenience, not a
 * key management system — see ADR-0033.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly keys: Map<string, MasterKey>;
  private readonly active: MasterKey;

  constructor(keyring: Keyring) {
    this.keys = new Map(Object.entries(keyring.keys).map(([id, material]) => [id, masterKey(id, material)]));
    const active = this.keys.get(keyring.active);
    if (!active) throw new EncryptionConfigError(`The active key "${keyring.active}" is not in the keyring`);
    this.active = active;
  }

  /**
   * A keyring from an environment variable (default `TYPESYS_ENCRYPTION_KEYS`)
   * of `id:base64` pairs separated by commas, the active key first — e.g.
   * `2026-09:…,2026-06:…` while the June key is being retired.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env, variable = "TYPESYS_ENCRYPTION_KEYS"): LocalKeyProvider {
    return new LocalKeyProvider(keyringFromEnv(env, variable));
  }

  async activeKey(): Promise<MasterKey> {
    return this.active;
  }

  async keyById(id: string): Promise<MasterKey | undefined> {
    return this.keys.get(id);
  }

  async allKeys(): Promise<MasterKey[]> {
    return [this.active, ...[...this.keys.values()].filter((k) => k !== this.active)];
  }
}
