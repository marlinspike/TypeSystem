import { describe, it, expect } from "vitest";
import { KMS } from "@aws-sdk/client-kms";
import { KeyUnavailableError, newWrappedKey, WrappedKeyProvider } from "@typesys/encryption";
import { AwsKmsKey } from "../src/index.js";

/**
 * The production gate for `AwsKmsKey` (ADR-0037, ADR-0046): the same contract
 * as `local-kms.test.ts`, against real AWS KMS, with the SDK's default
 * credential chain. Skipped unless `TYPESYS_AWS_KMS_KEY_ID` (a symmetric key
 * the credentials may use for `GenerateDataKeyWithoutPlaintext` and `Decrypt`)
 * and `TYPESYS_AWS_KMS_OTHER_KEY_ID` (a second one) are set. It creates,
 * disables, and deletes nothing. `AwsKmsKey` is not production-ready until
 * this has passed against the account and region a deployment will use.
 */
const KEY = process.env.TYPESYS_AWS_KMS_KEY_ID;
const OTHER = process.env.TYPESYS_AWS_KMS_OTHER_KEY_ID;

describe.skipIf(!KEY || !OTHER)("AwsKmsKey against real AWS KMS — the production gate", () => {
  const client = new KMS({});

  it("mints and unwraps a keyring", async () => {
    const kek = new AwsKmsKey(client, { keyId: KEY! });
    const keyring = { keys: { "2026-09": await newWrappedKey(kek, "2026-09"), "2026-06": await newWrappedKey(kek, "2026-06") }, active: "2026-09" };
    const provider = await WrappedKeyProvider.open(kek, keyring);
    expect((await provider.allKeys()).map((k) => [k.id, k.material.length])).toEqual([["2026-09", 32], ["2026-06", 32]]);
    expect(provider.management).toBe("managed");
  });

  it("refuses a data key wrapped under another KMS key, or relabeled", async () => {
    const kek = new AwsKmsKey(client, { keyId: KEY! });
    const foreign = await newWrappedKey(new AwsKmsKey(client, { keyId: OTHER! }), "k");
    await expect(WrappedKeyProvider.open(kek, { keys: { k: foreign }, active: "k" })).rejects.toThrow(KeyUnavailableError);
    const relabeled = await newWrappedKey(kek, "a");
    await expect(WrappedKeyProvider.open(kek, { keys: { b: relabeled }, active: "b" })).rejects.toThrow(KeyUnavailableError);
  });
});
