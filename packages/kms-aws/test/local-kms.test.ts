import { describe, it, expect, beforeAll } from "vitest";
import { KMS } from "@aws-sdk/client-kms";
import { KeyUnavailableError, newWrappedKey, WrappedKeyProvider } from "@typesys/encryption";
import { AwsKmsKey, type KmsCommands } from "../src/index.js";

/**
 * ADR-0037 against a KMS-compatible server through the real AWS SDK v3
 * client: `local-kms` in CI (`KMS_ENDPOINT`), or a real account if pointed
 * at one. Skipped without `KMS_ENDPOINT`. An emulator, not AWS KMS itself.
 */
const KMS_ENDPOINT = process.env.KMS_ENDPOINT;

describe.skipIf(!KMS_ENDPOINT)("AwsKmsKey against a KMS endpoint (ADR-0037)", () => {
  const client = new KMS({ region: "us-east-1", endpoint: KMS_ENDPOINT, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  // The SDK's own client is what the structural interface must accept.
  const commands: KmsCommands = client;
  let primary: string;
  let other: string;

  beforeAll(async () => {
    const create = async () => (await client.createKey({ KeyUsage: "ENCRYPT_DECRYPT", KeySpec: "SYMMETRIC_DEFAULT" })).KeyMetadata!.KeyId!;
    primary = await create();
    other = await create();
  });

  it("mints and unwraps a keyring through the real SDK", async () => {
    const kek = new AwsKmsKey(commands, { keyId: primary });
    const keyring = { keys: { "2026-09": await newWrappedKey(kek, "2026-09"), "2026-06": await newWrappedKey(kek, "2026-06") }, active: "2026-09" };
    const provider = await WrappedKeyProvider.open(kek, keyring);
    expect((await provider.allKeys()).map((k) => [k.id, k.material.length])).toEqual([["2026-09", 32], ["2026-06", 32]]);
  });

  it("attack: a data key wrapped under another KMS key, or relabeled, is refused", async () => {
    const kek = new AwsKmsKey(commands, { keyId: primary });
    const foreign = await newWrappedKey(new AwsKmsKey(commands, { keyId: other }), "k");
    await expect(WrappedKeyProvider.open(kek, { keys: { k: foreign }, active: "k" })).rejects.toThrow(KeyUnavailableError);
    const relabeled = await newWrappedKey(kek, "a");
    await expect(WrappedKeyProvider.open(kek, { keys: { b: relabeled }, active: "b" })).rejects.toThrow(KeyUnavailableError);
  });

  it("attack: a disabled KMS key refuses to unwrap", async () => {
    const kek = new AwsKmsKey(commands, { keyId: other });
    const keyring = { keys: { k: await newWrappedKey(kek, "k") }, active: "k" };
    await client.disableKey({ KeyId: other });
    await expect(WrappedKeyProvider.open(kek, keyring)).rejects.toThrow(KeyUnavailableError);
  });
});
