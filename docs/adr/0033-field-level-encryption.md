# 0033. Field-Level Encryption: An Encrypting Adapter and a KeyProvider Seam

## Status

Accepted — implemented as `@typesys/encryption` (`EncryptingAdapter` in
`src/encrypting-adapter.ts`, the construction in `src/cipher.ts`,
`KeyProvider` / `LocalKeyProvider` in `src/keys.ts`), with no change to any
adapter, domain, or `@typesys/core`. Proven by:

- `packages/encryption/test/encrypting-adapter.test.ts` — round trips of
  every JSON type; randomized envelopes never repeating, deterministic
  indexes repeating only per field and key; `eq` / `in` / `ne` through the
  index, alone and inside `and` / `or`, through the runtime and in a count;
  every refusal (range, substring, randomized equality, sort, aggregation,
  key-based relationship, default search, reserved names, bad config); a
  real write path (`CreateMaintenanceWorkOrder` through the mock REST
  system, the store holding only ciphertext); unlisted Actions refused;
  legacy plaintext failing closed; rotation (old values readable, new
  writes under the new key, equality spanning both, a dropped key failing
  closed); an **attack** block on the hospital domain with its PHI
  encrypted — the store read directly shows no plaintext in any encoding,
  seven kinds of tampered ciphertext and a moved ciphertext each fail
  authentication, an edited blind index can't redirect a lookup, the wrong
  key and a missing key fail closed without plaintext, and no error carries
  a value; and **transparency** — every hospital read path, for every demo
  identity and an admin, returns the same results encrypted as not,
  row-level rules included.
- `packages/encryption/test/local-key-provider.test.ts` — keyring
  validation and `TYPESYS_ENCRYPTION_KEYS` parsing.
- `packages/encryption/test/postgres.test.ts` — against a real PostgreSQL
  row: no plaintext in the database, equality through the index, and a
  ciphertext tampered with in SQL failing closed. Env-gated; run and passing
  against a local PostgreSQL 17 during implementation, and in CI's Postgres
  job.

Mutation-checked: dropping the AAD's place, passing plaintext through,
skipping index verification, sharing one index key across fields, letting
an unsupported operator through, allowing unlisted Actions, a fixed IV,
exposing the index field, looking up equality under the active key only,
swallowing an authentication failure, or allowing a sort or a relationship
on an encrypted field each fails the suite.

**Pinned residual:** a ciphertext swapped between two records of the same
Type and field is *not* detected (point 3); a test asserts that, so closing
it will be a visible change. *Closed by ADR-0035:* envelopes are now
`tsenc2`, bound to their record, and that test asserts the swap is
detected; `seal` takes the record's id, and Actions name the input field
holding it.

## Context

`PRODUCTION-READINESS.md` item 4 says encryption at rest is "not addressed
anywhere." Database-level encryption (a Postgres volume or tablespace
encrypted by the platform) protects against a stolen disk, but not against
anyone who can query the database — an operator, a backup, a SQL injection
in some other application sharing it, a replica in a less trusted
environment. For PHI and classified fields (ADR-0030, ADR-0032) the
requirement is stronger: the sensitive *field* is ciphertext in every
store, and only the runtime, holding the key, ever sees the plaintext.

Two properties of this codebase shape where that belongs. Every read and
write already crosses the `Adapter` interface (ADR-0006), so a decorator
around an adapter sees every value on its way in and out without any
adapter changing — the demo's `tracked()` wrapper already composes this
way. And the store does work on values: adapters filter, sort, page,
aggregate, and resolve relationships by field value, all of which stop
working, or silently return wrong answers, once a field is ciphertext.

## Decision

**1. A new optional package, `@typesys/encryption`, whose
`EncryptingAdapter` wraps any `Adapter`.** It implements the same
interface, delegates to the inner adapter, and changes values only at the
boundary: encrypt on the way in, decrypt on the way out. No adapter, no
domain, and nothing in `@typesys/core` changes; the runtime (and so policy,
classification, audit, and caching) sees plaintext exactly as before. It
depends only on `node:crypto`.

**2. Configuration names the encrypted fields, per Type.**

```ts
new EncryptingAdapter(inner, keys, {
  fields: { "hospital.Patient": { medicalRecordNumber: { mode: "deterministic" }, dateOfBirth: {} } },
  actions: { RegisterPatient: "hospital.Patient", CreateMaintenanceWorkOrder: null }
});
```

A field is **randomized** by default: AES-256-GCM with a fresh 96-bit IV per
write, so equal plaintexts never produce equal ciphertexts. A
**deterministic** field is encrypted the same way *and* gets an HMAC-SHA-256
blind index stored beside it (`__bidx_<field>`), so equality can still be
answered without decrypting: `eq`, `ne`, and `in` filters on it are rewritten
to the index. Any value that survives `JSON.stringify` can be encrypted, and
it decrypts to the same type.

**3. The envelope is self-describing and bound to its place.** A stored
value becomes `tsenc1.<keyId>.<iv>.<ciphertext+tag>` (base64url), with
additional authenticated data `tsenc1|<type>|<field>|<keyId>`. Moving a
ciphertext into another field or Type, or editing its key id, fails
authentication. It is not bound to its *record*: an object's id often
doesn't exist yet when the value is written (the adapter assigns it on
create), so the envelope can't name it.

**4. Keys come from a `KeyProvider`; the adapter never holds raw key
config.** Three methods: `activeKey()` (new writes), `keyById(id)` (the key
an envelope names — active or retired), and `allKeys()` (every key a blind
index may have been computed under). Each key is 32 bytes of master
material; the adapter derives separate subkeys with HKDF-SHA-256 — one for
encryption, and one per Type-and-field for blind indexes, so the same value
in two fields has unrelated indexes. `LocalKeyProvider` holds a keyring in
process memory, from code or from `TYPESYS_ENCRYPTION_KEYS`
(`id:base64,id:base64`, active first). A KMS is the same interface: a
provider that keeps data keys wrapped under a KMS master key and unwraps them
on first use (envelope encryption) — documented as the seam, not built.

**5. Rotation is a keyring, not a migration.** Writes use the active key;
every envelope names its key, so values written under a retired key keep
decrypting while it stays in the ring; equality filters look a value up
under every key's index at once (`in`), so indexes written before a rotation
still match. Re-encrypting old values under the new key is an ordinary
read-and-write through the application's write path; removing a key from
the ring makes everything still under it unreadable — fail closed, by
design.

**6. What breaks is refused, never answered wrongly.** The store only has
ciphertext, so an operation that would need plaintext in the adapter throws
`EncryptedFieldError` (an `InvalidInputError`: the caller asked for
something this field can't do) naming the field and the operation:

- range (`gt`/`gte`/`lt`/`lte`), `contains`, and `icontains` filters, and
  equality on a randomized field;
- `sort` on an encrypted field;
- `aggregate` grouping by, or computing over, an encrypted field;
- full-text `search` over an encrypted field — including a *default* search,
  which ranges over every property, so a caller must name `search.properties`;
- a relationship resolved through an encrypted key field;
- a filter or write naming a reserved `__bidx_` field directly.

**7. Writes are accounted for, or refused.** `executeAction` encrypts the
input fields of the Type the config maps the Action to, and decrypts them
in its result; an Action mapped to `null` passes through. An Action the
config doesn't list is refused — it might write a protected field in
plaintext, and "might" is not good enough at rest. Bulk loads that go
through an adapter's own write method (`seed`, `put`) call `seal(type,
values)` first, which returns the record's stored form.

**8. Decryption fails closed.** A stored value that isn't a valid envelope,
names an unknown key, or fails the GCM tag — tampered, truncated, moved, or
under the wrong key — throws `DecryptionError`, naming the Type, field, and
object but never a value; the read fails rather than returning anything. A
deterministic field's blind index is checked against its decrypted value on
every read, so an edited index can't make an equality query return the
wrong record.

## Consequences

- A sensitive field is ciphertext in every store an adapter writes to —
  database rows, backups, replicas, the mock REST system — while every
  consumer, the policy engine, and classification see plaintext through the
  one runtime boundary.
- The runtime can no longer push work on encrypted fields down to the
  store. Equality on deterministic fields survives; range, sort, substring,
  aggregation, and key-based relationships on them do not, and say so.
- A deterministic field leaks equality: anyone who can read the store can
  tell which records share a value (not what it is). Randomized is the
  default for that reason.
- Every read of an encrypted field costs a decryption, and every equality
  filter a keyed hash per key in the ring. Small next to an adapter call.
- The decorator needs the store to persist the blind-index field; a store
  with a fixed schema that drops unknown fields (the mock REST system) can
  hold randomized fields, not deterministic ones.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **The cryptographic construction.** AES-256-GCM with random 96-bit IVs
  (NIST's limit is about 2^32 encryptions per key before IV collision risk
  becomes material — rotate well before that), HKDF subkeys, HMAC-SHA-256
  blind indexes, the envelope format, and the AAD contents. It uses only
  `node:crypto` primitives, but the composition has not been reviewed by a
  cryptographer.
- **Key management is the actual control.** `LocalKeyProvider` keeps keys
  in process memory, from an environment variable; that is a development
  convenience, not a key management system. Production needs a KMS-backed
  provider, access control and audit on the keys, and a rotation schedule
  (`PRODUCTION-READINESS.md` item 6).
- **Record binding.** A ciphertext can be swapped between records of the
  same Type and field by someone with write access to the store (point 3).
  If that matters, bind a stable record id into the AAD where one exists
  before the write.
- **Plaintext outside the adapter.** The runtime's `Cache` (ADR-0016) holds
  adapter output — decrypted values — so `resolutionMode: "cached"` on an
  encrypted Type puts plaintext in the cache (and in Redis, ADR-0025). Don't
  cache encrypted Types, or encrypt the cache too. Logs, traces, and error
  messages from other code are equally out of scope.
- **Blind-index leakage** (equality, frequency) is acceptable for
  identifiers looked up by exact value, not for low-cardinality fields
  (a boolean, a status) where frequency alone reveals the value.
- **Existing plaintext.** Turning encryption on for a field that already
  holds plaintext makes those rows unreadable (point 8) until they are
  re-written through `seal`. Plan the migration.

## Alternatives Considered

- **Encrypt inside each adapter.** Every adapter would re-implement the same
  cryptography and the same query rewriting, and a new adapter would start
  out unprotected. The decorator gives every adapter the same protection by
  composition, which is what the `Adapter` seam is for.
- **Encrypt in `SemanticRuntime`.** The runtime would then pass ciphertext
  to adapters and rewrite queries itself — but the runtime's job is policy
  on plaintext, and a runtime-level cipher would sit in the one place that
  must see plaintext anyway. Encryption at rest belongs at the storage
  boundary; the adapter is that boundary.
- **Database-native encryption only** (TDE, `pgcrypto`, an encrypted
  volume). Complementary and worth doing, but the database (and whoever can
  query it) holds the key, so it doesn't protect a field from the store's
  own operators or backups, and it doesn't cover non-database adapters.
- **Deterministic encryption (AES-SIV) instead of a blind index.** One
  column instead of two, but `node:crypto` has no SIV mode, and a home-made
  synthetic-IV construction is exactly what "prefer established
  primitives" rules out. A keyed-hash index beside randomized ciphertext is
  the established pattern (CipherSweet, client-side field encryption in
  document databases) and keeps the ciphertext itself randomized.
- **Order-preserving or searchable encryption** to keep range queries and
  sorting. Order-preserving schemes leak far more than equality and have a
  poor security record; refusing the operation with a clear error is the
  honest answer.
- **Silently pass through unlisted Actions.** Friendlier, and a quiet path
  to plaintext at rest the first time someone adds an Action and forgets the
  config. Refusing makes the omission loud.
