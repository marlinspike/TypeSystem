# @typesys/kms-aws

An AWS KMS key as the `KeyEncryptionKey` behind `@typesys/encryption`'s
`WrappedKeyProvider` ([ADR-0037](../../docs/adr/0037-kms-backed-key-provider.md)):
field-encryption data keys live in configuration only in wrapped form, and
only an instance allowed to use the KMS key can unwrap them.

```ts
import { KMS } from "@aws-sdk/client-kms";
import { EncryptingAdapter, WrappedKeyProvider } from "@typesys/encryption";
import { AwsKmsKey } from "@typesys/kms-aws";

const kek = new AwsKmsKey(new KMS({ region: "us-east-1" }), { keyId: "alias/typesys" });
// TYPESYS_WRAPPED_KEYS="2026-09:<wrapped>,2026-06:<wrapped>", active first
const keys = await WrappedKeyProvider.fromEnv(kek); // unwraps every key, or rejects: don't start
const patients = new EncryptingAdapter(inner, keys, config);
```

Mint a keyring entry (the data key's plaintext never leaves KMS):

```ts
import { newWrappedKey } from "@typesys/encryption";
console.log(`2026-10:${await newWrappedKey(kek, "2026-10")}`);
```

## What it does

- New data keys come from `GenerateDataKeyWithoutPlaintext` (`AES_256`).
- Every `Decrypt` names the configured KMS key, so a data key wrapped under
  any other KMS key is refused, not decrypted under whichever key wrapped it.
- The keyring id is bound as encryption context (`typesys:key-id`), so a
  wrapped key can't be relabeled as another id.
- It depends on no AWS SDK: any client with `generateDataKeyWithoutPlaintext`
  and `decrypt` fits — the SDK v3 `KMS` client does, checked at compile time.

The lease — refresh after 5 minutes, refuse after 15 without a successful
refresh, retries 30 seconds apart — is `WrappedKeyProvider`'s; see its
options.

## Permissions

Instances need only `kms:Decrypt` on the key; whatever mints keyring
entries needs `kms:GenerateDataKeyWithoutPlaintext`. Scope both with a
`kms:EncryptionContextKeys` condition on `typesys:key-id` if the key is
shared.

## Tested against

A fake of the two calls modeled on AWS's documented behavior, and — through
the real SDK client — the [`local-kms`](https://github.com/nsmithuk/local-kms)
emulator in CI (`KMS_ENDPOINT`). Not against AWS KMS itself: key policies,
IAM, CloudTrail, and multi-region keys are the deployment's to verify.
