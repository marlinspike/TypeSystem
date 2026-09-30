---
"@typesys/encryption": minor
"@typesys/kms-aws": minor
---

KMS-backed keys (ADR-0037). New `WrappedKeyProvider` in `@typesys/encryption` holds a keyring of data keys wrapped by a `KeyEncryptionKey`: `open()` (or `fromEnv`, reading `TYPESYS_WRAPPED_KEYS`) unwraps every key or rejects with the new `KeyUnavailableError`, and unwrapped keys are leased — refreshed in the background after `refreshAfterMs`, kept through a failed refresh, and refused once `maxKeyAgeMs` passes without a successful one, with retries spaced by `retryIntervalMs`. `newWrappedKey(kek, keyId)` mints a keyring entry. New package `@typesys/kms-aws` provides `AwsKmsKey`, an AWS KMS key over any client exposing `generateDataKeyWithoutPlaintext` and `decrypt` (the AWS SDK v3 `KMS` client fits), pinning every `Decrypt` to the configured KMS key and binding each data key's id as encryption context.
