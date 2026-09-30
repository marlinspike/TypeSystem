import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { DecryptionError } from "./errors.js";
import type { KeyProvider, MasterKey } from "./keys.js";

/** Where a value lives. Its ciphertext is bound to this, and its blind-index key derived for it. */
export interface FieldRef {
  typeName: string;
  field: string;
}

const VERSION = "tsenc1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** `tsenc1.<keyId>.<iv>.<ciphertext+tag>`, base64url throughout. */
const ENVELOPE = /^tsenc1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;

/** JSON arrays, not delimiters, so no field or Type name can make two contexts collide. */
const aad = (ref: FieldRef, keyId: string) => Buffer.from(JSON.stringify([VERSION, ref.typeName, ref.field, keyId]), "utf8");
const ENCRYPTION_INFO = JSON.stringify([VERSION, "aes-256-gcm"]);
const indexInfo = (ref: FieldRef) => JSON.stringify([VERSION, "blind-index", ref.typeName, ref.field]);

function where(ref: FieldRef, objectId: string): string {
  return `${ref.typeName}.${ref.field} of "${objectId}"`;
}

/**
 * The cryptography of ADR-0033, and nothing else: AES-256-GCM envelopes with
 * a random IV and the value's place as additional authenticated data, and
 * HMAC-SHA-256 blind indexes — each under its own HKDF-SHA-256 subkey of a
 * `KeyProvider` master key.
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

  /** A fresh envelope for `value` under the active key: equal plaintexts never give equal envelopes. */
  async encrypt(ref: FieldRef, value: unknown): Promise<string> {
    const key = await this.keys.activeKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.subkey(key, ENCRYPTION_INFO), iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(ref, key.id));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${VERSION}.${key.id}.${iv.toString("base64url")}.${body.toString("base64url")}`;
  }

  /** The value an envelope holds — or `DecryptionError`, never anything else. */
  async decrypt(ref: FieldRef, stored: unknown, objectId: string): Promise<unknown> {
    const match = typeof stored === "string" ? ENVELOPE.exec(stored) : null;
    if (!match) throw new DecryptionError(`${where(ref, objectId)} is not an encrypted value`);
    const [, keyId, iv, encoded] = match as unknown as [string, string, string, string];
    const key = await this.keys.keyById(keyId);
    if (!key) throw new DecryptionError(`${where(ref, objectId)} is under key "${keyId}", which the keyring doesn't hold`);

    const body = Buffer.from(encoded, "base64url");
    try {
      if (body.length <= TAG_BYTES) throw new Error("truncated");
      const decipher = createDecipheriv("aes-256-gcm", this.subkey(key, ENCRYPTION_INFO), Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(ref, keyId));
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      const plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch {
      throw new DecryptionError(`${where(ref, objectId)} failed authentication: tampered, moved, or under a different key`);
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
