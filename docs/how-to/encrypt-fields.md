# How to encrypt fields at rest

Wrap the adapter that stores a sensitive field in `EncryptingAdapter`, and
that field is ciphertext in the store while every consumer still reads
plaintext through the runtime
([ADR-0033](../adr/0033-field-level-encryption.md)).

## 1. Get keys

```bash
openssl rand -base64 32
```

Put the key in `TYPESYS_ENCRYPTION_KEYS` as `id:base64` (more keys,
comma-separated, active first) and build a provider:

```ts
import { LocalKeyProvider } from "@typesys/encryption";
const keys = LocalKeyProvider.fromEnv();
```

`LocalKeyProvider` is for development. In production, implement
`KeyProvider` against your KMS.

## 2. Wrap the adapter

```ts
const adapter = new EncryptingAdapter(innerAdapter, keys, {
  fields: { "hospital.Patient": { medicalRecordNumber: { mode: "deterministic" }, dateOfBirth: {} } },
  actions: { RegisterPatient: "hospital.Patient" }
});
```

Pass `adapter` to the runtime in place of `innerAdapter`. Choose
`deterministic` only for a field you must look up by exact value (an
identifier); it lets the store see which records share a value. Everything
else stays randomized.

List every Action the adapter executes under `actions` — mapped to the Type
its input writes, or `null`. An unlisted Action is refused.

## 3. Load data through `seal`

A seed or bulk import that calls an adapter's own write method (`seed`,
`put`) must write the sealed form:

```ts
await pg.put(type, id, await adapter.seal(type, values));
```

Existing plaintext in a field you start encrypting fails to read until it
is re-written this way.

## What stops working

On an encrypted field the store can't filter by range or substring, sort,
aggregate, search, or resolve a relationship; each is refused with an
`EncryptedFieldError` saying so. On a deterministic field `eq`, `ne`, and
`in` filters keep working. Don't set `resolutionMode: "cached"` on an
encrypted Type: the cache holds decrypted values.

## Rotate

Add a new key at the front of `TYPESYS_ENCRYPTION_KEYS`, keep the old one
behind it, and redeploy. Old values keep reading; new writes use the new key.
Re-write old records at your pace, then drop the old key.

## Verify it

[`packages/encryption/test/encrypting-adapter.test.ts`](../../packages/encryption/test/encrypting-adapter.test.ts)
reads the store directly to show no plaintext, tampers with ciphertexts and
indexes, uses the wrong key, rotates, and checks every hospital read path
returns the same results encrypted as not.
