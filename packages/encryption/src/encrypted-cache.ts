import { createHmac } from "node:crypto";
import type { Cache } from "@typesys/core";
import { gcmOpen, gcmSeal, Subkeys } from "./cipher.js";
import { DecryptionError } from "./errors.js";
import type { KeyProvider, MasterKey } from "./keys.js";

const VERSION = "tscache1";
/** Their own HKDF labels, apart from the field subkeys, so a cache entry and a field envelope can never stand in for each other. */
const ENCRYPTION_INFO = JSON.stringify([VERSION, "aes-256-gcm"]);
const NAME_INFO = JSON.stringify([VERSION, "key-name"]);
/** `tscache1.<keyId>.<expiresAt>.<iv>.<ciphertext+tag>`, base64url apart from the expiry's epoch milliseconds. */
const ENTRY = /^tscache1\.([A-Za-z0-9_-]{1,64})\.(\d{1,16})\.([A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+)$/;

/** Binds an entry to the cache key it was written under and the expiry it was written with. */
function aad(key: string, keyId: string, expiresAt: number): Buffer {
  return Buffer.from(JSON.stringify([VERSION, key, keyId, expiresAt]), "utf8");
}

export interface EncryptedCacheOptions {
  /**
   * Called when a stored entry can't be decrypted — tampered, moved to
   * another key, or under a key the ring doesn't hold. The entry is a miss:
   * the runtime reads live, and nothing the store supplied is served. The
   * error names no cache key or value. Defaults to `console.warn`.
   */
  onError?: (err: DecryptionError) => void;
}

/**
 * A confidential `Cache` over any other (ADR-0036) — `RedisCache` is the
 * case it's for. Values are sealed with AES-256-GCM under the same
 * `KeyProvider` as encrypted fields, bound to their cache key and expiry;
 * cache keys are replaced by an HMAC, so the store learns neither what is
 * cached nor about which objects. Values must be JSON-serializable.
 */
export class EncryptedCache implements Cache {
  readonly confidential = true;
  private readonly subkeys = new Subkeys();
  private readonly onError: (err: DecryptionError) => void;

  constructor(
    private readonly inner: Cache,
    private readonly keys: KeyProvider,
    opts: EncryptedCacheOptions = {}
  ) {
    this.onError = opts.onError ?? ((err) => console.warn(`EncryptedCache: ${err.message}; treating it as a miss`));
  }

  private name(key: MasterKey, cacheKey: string): string {
    return `${VERSION}.${createHmac("sha256", this.subkeys.of(key, NAME_INFO)).update(cacheKey, "utf8").digest("base64url")}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const stored = await this.inner.get<unknown>(this.name(await this.keys.activeKey(), key));
    if (stored === undefined) return undefined;
    try {
      return (await this.open(key, stored)) as T | undefined;
    } catch (err) {
      this.onError(err as DecryptionError);
      return undefined;
    }
  }

  /** The value an entry holds, `undefined` once past the expiry it was written with, or `DecryptionError`. */
  private async open(key: string, stored: unknown): Promise<unknown> {
    const match = typeof stored === "string" ? ENTRY.exec(stored) : null;
    if (!match) throw new DecryptionError("a cache entry is not an EncryptedCache entry");
    const [, keyId, expiry, sealed] = match as unknown as [string, string, string, string];
    const expiresAt = Number(expiry);
    // Past its expiry, even if the store kept it or someone put it back: never served.
    if (Date.now() >= expiresAt) return undefined;
    const master = await this.keys.keyById(keyId);
    if (!master) throw new DecryptionError(`a cache entry is under key "${keyId}", which the keyring doesn't hold`);
    const [iv, body] = sealed.split(".") as [string, string];
    try {
      return JSON.parse(gcmOpen(this.subkeys.of(master, ENCRYPTION_INFO), aad(key, keyId, expiresAt), iv, body)) as unknown;
    } catch {
      throw new DecryptionError("a cache entry failed authentication: tampered, moved to another key, or under a different key");
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    // JSON has no `undefined`, and the runtime treats undefined as "not cached" anyway.
    if (value === undefined) return;
    const master = await this.keys.activeKey();
    const expiresAt = Date.now() + Math.max(1, Math.round(ttlMs));
    const sealed = gcmSeal(this.subkeys.of(master, ENCRYPTION_INFO), aad(key, master.id, expiresAt), JSON.stringify(value));
    await this.inner.set(this.name(master, key), `${VERSION}.${master.id}.${expiresAt}.${sealed}`, ttlMs);
  }

  /** Under every key in the ring, so an invalidation still lands on entries written before a rotation. */
  async delete(key: string): Promise<void> {
    for (const master of await this.keys.allKeys()) await this.inner.delete(this.name(master, key));
  }

  async clear(): Promise<void> {
    await this.inner.clear();
  }
}
