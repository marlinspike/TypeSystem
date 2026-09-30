# 0037. KMS-Backed Key Provider

## Status

*Amended by ADR-0046:* providers declare `management` (`"managed"` for
`WrappedKeyProvider`, `"local"` for `LocalKeyProvider`), which a security
profile checks; and `AwsKmsKey` has a real-AWS production gate.

Accepted — implemented as `WrappedKeyProvider`, `KeyEncryptionKey`, and
`newWrappedKey` in `@typesys/encryption` (`src/wrapped-keys.ts`), and
`AwsKmsKey` in the new `@typesys/kms-aws`. Proven by:

- `packages/encryption/test/wrapped-keys.test.ts` — a ring minted through
  the KMS encrypting and decrypting fields, with only wrapped keys in
  configuration; an **attack** block at startup where an unreachable KMS, a
  disabled key, one retired key that won't unwrap, a wrapped key relabeled
  as another id, and a KMS returning a 16-byte key each fail `open()`, and a
  malformed ring or lease is refused before the KMS is asked; the lease —
  no KMS call within `refreshAfterMs`, one background refresh for ten
  concurrent uses that none of them waits for, a renewed lease after it, a
  use past `maxKeyAgeMs` waiting for the refresh; and an **attack** block
  revoking the KMS key: reads keep working through the lease, then field
  reads, writes, deterministic lookups, `EncryptedCache`, and the keyring
  all fail with `KeyUnavailableError`; one KMS call per `retryIntervalMs`
  during an outage; recovery once access returns.
- `packages/kms-aws/test/aws-kms-key.test.ts` — against a fake of the two
  KMS calls: the exact requests (KMS key, `AES_256`, encryption context); a
  data key wrapped under another KMS key the caller may use, or relabeled,
  refused; a disabled KMS key refusing new instances and, after the lease,
  running ones; an empty response a `KeyUnavailableError`.
- `packages/kms-aws/test/local-kms.test.ts` — the same through the real AWS
  SDK v3 client, against `local-kms` in CI (`KMS_ENDPOINT`). The SDK
  client's fit to `KmsCommands` is also checked at compile time. Run locally
  against moto's KMS server too, where everything but the disabled-key case
  passed: moto's `Decrypt` ignores a key's disabled state; `local-kms`'s
  doesn't.

Mutation-checked (15 mutations): never expiring the lease; serving stale
keys when a forced refresh is spaced out or fails; substituting a key for
one that won't unwrap; accepting a key of the wrong length; dropping retry
spacing; not installing a refreshed ring; refreshing only at expiry;
dropping the lease, active-key, or duration validation; and in `AwsKmsKey`,
omitting the KMS key or the encryption context from `Decrypt`, binding no
key id, or accepting no KMS key — each fails the suites.

## Context

Field encryption (ADR-0033, ADR-0035) and `EncryptedCache` (ADR-0036) get
their keys from a `KeyProvider`. The only one built, `LocalKeyProvider`,
reads raw key material from an environment variable. That puts the one secret
protecting every encrypted field in the same place as every other
configuration value — process listings, crash dumps, CI logs, container
specs — with no access control, no audit of use, and no way to revoke it
short of redeploying every instance. `PRODUCTION-READINESS.md` items 4 and 6
list this as open.

A key management service (AWS KMS, Google Cloud KMS, Azure Key Vault)
answers all three: its keys never leave it, every use is authorized and
audited, and disabling a key revokes it. But a KMS round trip per field
decryption is far too slow and too costly, and makes every read depend on the
KMS being up. The standard answer is envelope encryption: data keys, each
wrapped (encrypted) by a KMS key, are unwrapped once and held in memory.

Two questions decide whether that is actually safer, and the interface
already in place doesn't answer them: what happens when the KMS can't be
reached, and how long a revoked key keeps working.

## Decision

**1. A keyring of wrapped data keys.** `WrappedKeyProvider` in
`@typesys/encryption` holds the same keyring as `LocalKeyProvider` — key ids,
one of them active — but each entry is a data key *wrapped* by a
`KeyEncryptionKey`, a small interface over a KMS key:

```ts
interface KeyEncryptionKey {
  readonly name: string;                                    // for errors, never secret
  generateWrappedKey(keyId: string): Promise<Uint8Array>;   // a new data key, wrapped
  unwrap(wrapped: Uint8Array, keyId: string): Promise<Uint8Array>;
}
```

A wrapped key is not a secret on its own, so the ring can live in ordinary
configuration (`TYPESYS_WRAPPED_KEYS`, same `id:base64` format, active
first). The key id is bound into every wrap (for AWS, as encryption
context), so a wrapped key can't be relabeled as another id.
`newWrappedKey(kek, keyId)` mints an entry; with AWS it calls
`GenerateDataKeyWithoutPlaintext`, so the new key's plaintext never leaves
the KMS until an instance unwraps it.

**2. Unreachable at startup: don't start.** `WrappedKeyProvider.open()`
unwraps every key in the ring before returning, and any failure — KMS down,
access denied, a key disabled, a wrapped key that isn't 32 bytes once
unwrapped — rejects with `KeyUnavailableError`. A process that can't unwrap
its keys never serves a request; a key no longer wanted must be removed from
the ring, not left to fail.

**3. Keys are leased, so revocation takes effect.** Unwrapped keys are held
for at most `maxKeyAgeMs` (default 15 minutes) from when they were unwrapped:

- after `refreshAfterMs` (default 5 minutes), the next use re-unwraps the
  ring in the background and keeps serving the current keys meanwhile;
- a failed refresh keeps the current keys — a KMS blip doesn't take reads
  down — and is reported to `onRefreshError`;
- once `maxKeyAgeMs` has passed without a successful refresh, every use
  awaits a refresh, and if that fails, rejects with `KeyUnavailableError`:
  reads and writes of encrypted fields, and `EncryptedCache`, fail closed;
- attempts are spaced at least `retryIntervalMs` (default 30 seconds) apart,
  so a KMS outage doesn't become one KMS call per request.

So disabling the KMS key, or revoking the instance's permission to use it,
stops every instance from encrypting or decrypting within `maxKeyAgeMs`, and
a KMS outage shorter than that is invisible. The lease runs on a clock the
provider reads on use; there are no background timers to keep a process
alive or to leak between tests.

**4. One package per KMS; AWS first.** `@typesys/kms-aws` provides
`AwsKmsKey`, a `KeyEncryptionKey` over any client exposing
`generateDataKeyWithoutPlaintext` and `decrypt` — the AWS SDK v3 `KMS` client
fits, and the package takes no dependency on the SDK. Every `decrypt` names
the configured KMS key, so a wrapped key produced under some other KMS key
is refused rather than decrypted under whichever key produced it. Other
KMSs are the same interface, not built.

**5. Rotation is two-phase.** Every instance must hold a key before any
instance writes under it (ADR-0036): first add the new wrapped key to every
instance's ring behind the active one, then make it active, then `reseal`
(ADR-0035) at leisure and drop the old key. Rotating the *KMS* key needs
none of this: its versions are the KMS's business, and wrapped keys keep
unwrapping.

## Consequences

- The secret that protects encrypted fields leaves process configuration;
  what remains there is wrapped keys and a KMS key id.
- Every instance needs KMS access at startup and at least once per
  `maxKeyAgeMs`, and the KMS is now a dependency of availability for
  encrypted data — bounded by the lease rather than per request.
- Revocation is bounded by `maxKeyAgeMs`, not immediate. Shorter leases mean
  faster revocation and more KMS calls.
- `LocalKeyProvider` stays, for development and tests.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **Unwrapped keys live in process memory** for the life of the lease, and
  JavaScript gives no way to guarantee they are erased afterwards. Anyone
  who can read the process's memory can read the keys; a KMS doesn't change
  that.
- **`AwsKmsKey` is tested against a fake of the two KMS calls and, in CI,
  against `local-kms`, an emulator — not against AWS KMS itself.** The
  key policy, IAM permissions (least privilege: `kms:Decrypt` for
  instances, `kms:GenerateDataKeyWithoutPlaintext` only where keys are
  minted), CloudTrail audit, and multi-region behavior are the deployment's
  to configure and verify.
- **Nothing refuses `LocalKeyProvider` in production.** A deployment
  profile that forbids raw keys belongs with the strict-mode decision (the
  ADR-0038 discussion); until then it is a review item.
- **Lease defaults are a starting point**, not a recommendation for any
  particular threat model.

## Alternatives Considered

- **Call the KMS for every decryption.** Revocation is immediate, but every
  read pays a network round trip and a per-request charge, and the KMS
  becomes a hard dependency of every read.
- **Unwrap once at startup and never again.** Simple, but a revoked key
  keeps working until every instance restarts, which defeats half the
  reason to use a KMS.
- **Background refresh timers.** They keep processes alive, need explicit
  shutdown, and are awkward to test; refreshing on use gives the same
  bounds.
- **Fail reads as soon as a refresh fails.** Turns every KMS blip into an
  outage for encrypted data; the lease already bounds how long stale keys
  are trusted.
- **Depend on the AWS SDK in `@typesys/kms-aws`.** The two calls are a
  structural interface (as `@typesys/redis` does with Redis), so the package
  needs no runtime dependency and deployments bring the SDK version they
  already use.
