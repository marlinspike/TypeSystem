import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { EncryptionConfigError, KeyUnavailableError, newWrappedKey, WrappedKeyProvider } from "@typesys/encryption";
import { AwsKmsKey, type KmsCommands } from "../src/index.js";

/**
 * ADR-0037: `AwsKmsKey` over a fake of the two KMS calls, modeled on AWS's
 * documented behavior: a ciphertext blob names the KMS key that made it; a
 * `Decrypt` without `KeyId` uses that key, one with `KeyId` refuses any other
 * (`IncorrectKeyException`); the encryption context must match exactly; a
 * disabled key refuses everything. `local-kms.test.ts` runs the same
 * provider against an emulator.
 */
class FakeKms implements KmsCommands {
  readonly calls: { op: string; input: Record<string, unknown> }[] = [];
  private readonly keys = new Map<string, { material: Buffer; enabled: boolean }>();
  /** Makes the next response come back empty, as a malformed or truncated response would. */
  emptyNext = false;

  createKey(id: string): string {
    this.keys.set(id, { material: randomBytes(32), enabled: true });
    return id;
  }
  disable(id: string): void {
    this.keys.get(id)!.enabled = false;
  }
  private usable(id: string) {
    const key = this.keys.get(id);
    if (!key) throw Object.assign(new Error(`Key '${id}' does not exist`), { name: "NotFoundException" });
    if (!key.enabled) throw Object.assign(new Error(`${id} is disabled.`), { name: "DisabledException" });
    return key;
  }
  private static aad(id: string, context: Record<string, string>) {
    return Buffer.from(JSON.stringify([id, Object.entries(context).sort()]));
  }

  async generateDataKeyWithoutPlaintext(input: Parameters<KmsCommands["generateDataKeyWithoutPlaintext"]>[0]) {
    this.calls.push({ op: "GenerateDataKeyWithoutPlaintext", input });
    const key = this.usable(input.KeyId);
    if (input.KeySpec !== "AES_256") throw new Error("ValidationException");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key.material, iv).setAAD(FakeKms.aad(input.KeyId, input.EncryptionContext));
    const body = Buffer.concat([cipher.update(randomBytes(32)), cipher.final(), cipher.getAuthTag()]);
    return { CiphertextBlob: this.emptyNext ? undefined : Buffer.concat([Buffer.from(`${input.KeyId}|`), iv, body]) };
  }

  async decrypt(input: Partial<Parameters<KmsCommands["decrypt"]>[0]> & { CiphertextBlob: Uint8Array }) {
    this.calls.push({ op: "Decrypt", input });
    const blob = Buffer.from(input.CiphertextBlob);
    const bar = blob.indexOf("|");
    const madeBy = blob.subarray(0, bar).toString();
    if (input.KeyId !== undefined && input.KeyId !== madeBy) throw Object.assign(new Error("IncorrectKeyException"), { name: "IncorrectKeyException" });
    const key = this.usable(madeBy);
    const iv = blob.subarray(bar + 1, bar + 13);
    const body = blob.subarray(bar + 13);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key.material, iv).setAAD(FakeKms.aad(madeBy, input.EncryptionContext ?? {}));
      decipher.setAuthTag(body.subarray(body.length - 16));
      const plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
      return { Plaintext: this.emptyNext ? undefined : plaintext };
    } catch {
      throw Object.assign(new Error("InvalidCiphertextException"), { name: "InvalidCiphertextException" });
    }
  }
}

function world() {
  const kms = new FakeKms();
  const primary = kms.createKey("alias/typesys");
  const kek = new AwsKmsKey(kms, { keyId: primary });
  return { kms, kek };
}

describe("AwsKmsKey (ADR-0037)", () => {
  it("mints data keys with GenerateDataKeyWithoutPlaintext and unwraps them with Decrypt, both pinned to the KMS key and the key id", async () => {
    const { kms, kek } = world();
    expect(kek.name).toBe("aws-kms:alias/typesys");
    const wrapped = await newWrappedKey(kek, "2026-09");
    const provider = await WrappedKeyProvider.open(kek, { keys: { "2026-09": wrapped }, active: "2026-09" });
    expect((await provider.activeKey()).material).toHaveLength(32);
    const [generate, decrypt] = kms.calls;
    expect(generate).toEqual({ op: "GenerateDataKeyWithoutPlaintext", input: { KeyId: "alias/typesys", KeySpec: "AES_256", EncryptionContext: { "typesys:key-id": "2026-09" } } });
    expect(decrypt).toEqual({ op: "Decrypt", input: { CiphertextBlob: Buffer.from(wrapped, "base64"), KeyId: "alias/typesys", EncryptionContext: { "typesys:key-id": "2026-09" } } });
    expect(kms.calls).toHaveLength(2);
  });

  describe("attack", () => {
    it("a data key wrapped under another KMS key is refused, even one the caller may use", async () => {
      const { kms, kek } = world();
      const elsewhere = new AwsKmsKey(kms, { keyId: kms.createKey("alias/someone-else") });
      const foreign = await newWrappedKey(elsewhere, "2026-09");
      await expect(WrappedKeyProvider.open(kek, { keys: { "2026-09": foreign }, active: "2026-09" })).rejects.toThrow(KeyUnavailableError);
    });

    it("a wrapped key relabeled as another key id is refused", async () => {
      const { kek } = world();
      const wrapped = await newWrappedKey(kek, "2026-06");
      await expect(WrappedKeyProvider.open(kek, { keys: { "2026-09": wrapped }, active: "2026-09" })).rejects.toThrow(/Key "2026-09" could not be unwrapped by aws-kms:alias\/typesys/);
    });

    it("disabling the KMS key refuses new instances and, after the lease, running ones", async () => {
      const { kms, kek } = world();
      const keyring = { keys: { k: await newWrappedKey(kek, "k") }, active: "k" };
      let clock = 0;
      const running = await WrappedKeyProvider.open(kek, keyring, { now: () => clock, onRefreshError: () => undefined });
      kms.disable("alias/typesys");
      const refused = await WrappedKeyProvider.open(kek, keyring).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(KeyUnavailableError);
      expect((refused as Error & { cause: Error }).cause.name).toBe("DisabledException");
      clock += 15 * 60_000;
      await expect(running.activeKey()).rejects.toThrow(KeyUnavailableError);
    });

    it("an empty KMS response is a KeyUnavailableError, not an empty key", async () => {
      const { kms, kek } = world();
      kms.emptyNext = true;
      await expect(kek.generateWrappedKey("k")).rejects.toThrow(KeyUnavailableError);
      kms.emptyNext = false;
      const wrapped = await newWrappedKey(kek, "k");
      kms.emptyNext = true;
      await expect(WrappedKeyProvider.open(kek, { keys: { k: wrapped }, active: "k" })).rejects.toThrow(KeyUnavailableError);
    });
  });

  it("refuses to be built without a KMS key", () => {
    const { kms } = world();
    for (const keyId of ["", "  ", undefined]) expect(() => new AwsKmsKey(kms, { keyId: keyId as unknown as string })).toThrow(EncryptionConfigError);
  });
});
