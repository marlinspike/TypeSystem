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
  actions: { RegisterPatient: { type: "hospital.Patient", idField: "id" } }
});
```

Pass `adapter` to the runtime in place of `innerAdapter`. Choose
`deterministic` only for a field you must look up by exact value (an
identifier); it lets the store see which records share a value. Everything
else stays randomized.

List every Action the adapter executes under `actions` — mapped to the Type
its input writes and the input field holding the record's id, or to `null`
if it writes no encrypted field. An unlisted Action is refused.

Every ciphertext is bound to its record
([ADR-0035](../adr/0035-record-bound-encryption-envelope.md)): moved to
another record, it no longer decrypts. So a write must know the record's id
*before* it runs — an Action writing encrypted fields without an id in its
input is refused. If your adapter assigns ids itself, generate them
client-side (a ULID) for encrypted Types, or keep encrypted fields out of
those creates.

## 3. Load data through `seal`

A seed or bulk import that calls an adapter's own write method (`seed`,
`put`) must write the sealed form:

```ts
await pg.put(type, id, await adapter.seal(type, id, values));
```

Existing plaintext in a field you start encrypting fails to read until it
is re-written this way.

## Migrate a store sealed before record binding

Values written before ADR-0035 are unbound `tsenc1` envelopes, and they are
refused by default — accepting them would let anyone with write access to the
store plant another record's old ciphertext. To migrate, set
`legacyUnboundEnvelopes: "read"` briefly, rewrite every record through
`reseal`, and set it back:

```ts
await pg.put(type, id, await adapter.reseal(type, id, storedValues));
```

Keep that window short: while it's open, a downgrade to an unbound ciphertext
is accepted.

## What stops working

On an encrypted field the store can't filter by range or substring, sort,
aggregate, search, or resolve a relationship; each is refused with an
`EncryptedFieldError` saying so. On a deterministic field `eq`, `ne`, and
`in` filters keep working.

## Caching

The runtime's cache holds decrypted values, so it keeps encrypted fields —
and computed values derived from them — out of any cache that isn't
confidential ([ADR-0036](../adr/0036-sensitive-data-caching.md)). An
in-process `InMemoryCache` is fine. `RedisCache` isn't: a cached-mode read of
an encrypted Type skips it and reads live (`typesys.cache.requests
{result="bypass"}`). To share a cache across replicas, wrap it:

```ts
import { EncryptedCache } from "@typesys/encryption";

const runtime = new SemanticRuntime(registry, [patients], policyEngine, {
  cache: new EncryptedCache(new RedisCache(redis), keys)
});
```

Redis then holds sealed values under HMAC'd key names. An entry that has
been tampered with, moved, or kept past its TTL reads as a miss.

## Rotate

Add a new key at the front of `TYPESYS_ENCRYPTION_KEYS`, keep the old one
behind it, and redeploy. Old values keep reading; new writes use the new key.
Re-encrypt old records at your pace with `reseal`, then drop the old key.

## Verify it

[`packages/encryption/test/encrypting-adapter.test.ts`](../../packages/encryption/test/encrypting-adapter.test.ts)
reads the store directly to show no plaintext, tampers with ciphertexts and
indexes, uses the wrong key, rotates, and checks every hospital read path
returns the same results encrypted as not;
[`record-binding.test.ts`](../../packages/encryption/test/record-binding.test.ts)
moves ciphertexts between records, attempts downgrades, and migrates with
`reseal`.
