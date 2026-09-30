import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { DecryptionError } from "./errors.js";
import type { KeyProvider, MasterKey } from "./keys.js";

/** Where a value lives: its Type and field. Its blind-index key is derived for this; its ciphertext is bound to this and its record. */
export interface FieldRef {
  typeName: string;
  field: string;
}

/**
 * `tsenc2` binds a ciphertext to its record (ADR-0035); `tsenc1` (ADR-0033)
 * binds only its Type and field, and is read only during a migration.
 */
export type EnvelopeVersion = "tsenc1" | "tsenc2";
const CURRENT: EnvelopeVersion = "tsenc2";
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** `<version>.<keyId>.<iv>.<ciphertext+tag>`, base64url throughout. */
const ENVELOPE = /^(tsenc[12])\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;

/** JSON arrays, not delimiters, so no id, field, or Type name can make two contexts collide. */
function aad(version: EnvelopeVersion, ref: FieldRef, keyId: string, objectId: string): Buffer {
  const context = version === "tsenc1" ? [version, ref.typeName, ref.field, keyId] : [version, ref.typeName, ref.field, keyId, objectId];
  return Buffer.from(JSON.stringify(context), "utf8");
}

/**
 * The HKDF labels are fixed, independent of the envelope version: every
 * version decrypts under the same subkey, and blind indexes don't change,
 * so a migration can read what it re-encrypts.
 */
const ENCRYPTION_INFO = JSON.stringify(["tsenc1", "aes-256-gcm"]);
const indexInfo = (ref: FieldRef) => JSON.stringify(["tsenc1", "blind-index", ref.typeName, ref.field]);

function where(ref: FieldRef, objectId: string): string {
  return `${ref.typeName}.${ref.field} of "${objectId}"`;
}

/**
 * The cryptography of ADR-0033 and ADR-0035, and nothing else: AES-256-GCM
 * envelopes with a random IV and the value's place — Type, field, key, and
 * record — as additional authenticated data, and HMAC-SHA-256 blind indexes,
 * each under its own HKDF-SHA-256 subkey of a `KeyProvider` master key.
 */
export class FieldCipher {
  /** Derived subkeys per master key object, so a provider handing back new key objects never gets a stale subkey. */
  private readonly subkeys = new WeakMap<MasterKey, Map<string, Buffer>>();

  constructor(private readonly keys: KeyProvider) {}

  private subkey(key: MasterKey, info: string): Buffer {
    let derived = this.subkeys.get(key);
    if (!derived) this.subkeys.set(key, (derived = new Map<string, Buffer>()));
    let subkey = derived.get(info);
    if (!subkey) derived.set(info, (subkey = Buffer.from(hkdfSync("sha256", key.material, Buffer.alloc(0), info, 32))));
    return subkey;
  }

  /** A fresh `tsenc2` envelope for `value`, under the active key and bound to record `objectId`: equal plaintexts never give equal envelopes. */
  async encrypt(ref: FieldRef, objectId: string, value: unknown): Promise<string> {
    const key = await this.keys.activeKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.subkey(key, ENCRYPTION_INFO), iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(CURRENT, ref, key.id, objectId));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${CURRENT}.${key.id}.${iv.toString("base64url")}.${body.toString("base64url")}`;
  }

  /**
   * The value an envelope holds, if it authenticates as belonging to record
   * `objectId` — or `DecryptionError`, never anything else. An unbound
   * `tsenc1` envelope is refused unless `acceptUnbound` (a migration).
   */
  async decrypt(ref: FieldRef, objectId: string, stored: unknown, acceptUnbound: boolean): Promise<unknown> {
    const match = typeof stored === "string" ? ENVELOPE.exec(stored) : null;
    if (!match) throw new DecryptionError(`${where(ref, objectId)} is not an encrypted value`);
    const [, version, keyId, iv, encoded] = match as unknown as [string, EnvelopeVersion, string, string, string];
    if (version === "tsenc1" && !acceptUnbound) {
      throw new DecryptionError(`${where(ref, objectId)} is an unbound tsenc1 envelope, refused outside a migration; reseal it (ADR-0035)`);
    }
    const key = await this.keys.keyById(keyId);
    if (!key) throw new DecryptionError(`${where(ref, objectId)} is under key "${keyId}", which the keyring doesn't hold`);

    const body = Buffer.from(encoded, "base64url");
    try {
      if (body.length <= TAG_BYTES) throw new Error("truncated");
      const decipher = createDecipheriv("aes-256-gcm", this.subkey(key, ENCRYPTION_INFO), Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(version, ref, keyId, objectId));
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      const plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch {
      throw new DecryptionError(`${where(ref, objectId)} failed authentication: tampered, moved to another record, or under a different key`);
    }
  }

  private index(key: MasterKey, ref: FieldRef, value: unknown): string {
    return createHmac("sha256", this.subkey(key, indexInfo(ref))).update(JSON.stringify(value), "utf8").digest("base64url");
  }

  /** The blind index a write stores beside a deterministic field: under the active key. */
  async activeIndex(ref: FieldRef, value: unknown): Promise<string> {
    return this.index(await this.keys.activeKey(), ref, value);
  }

  /** The value's index under every key in the ring — what an equality lookup matches, so it spans a rotation. */
  async indexes(ref: FieldRef, value: unknown): Promise<string[]> {
    return (await this.keys.allKeys()).map((key) => this.index(key, ref, value));
  }

  /** A stored index must be one its decrypted value produces; otherwise an edited index could redirect an equality lookup. */
  async verifyIndex(ref: FieldRef, value: unknown, stored: unknown, objectId: string): Promise<void> {
    if (stored === undefined) return;
    if (!(await this.indexes(ref, value)).includes(stored as string)) {
      throw new DecryptionError(`${where(ref, objectId)} has a blind index that doesn't match its value`);
    }
  }
}
