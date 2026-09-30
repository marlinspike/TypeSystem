# 0036. Sensitive-Data Caching and `EncryptedCache`

## Status

Accepted — implemented in `@typesys/core` (`Cache.confidential`,
`Adapter.sensitiveFields`, and the bypass in `SemanticRuntime`'s three cache
paths), `@typesys/encryption` (`EncryptedCache`, and `sensitiveFields` on
`EncryptingAdapter`), and `@typesys/redis` (`RedisCache` declared not
confidential). Proven by:

- `packages/core/test/sensitive-caching.test.ts` — an **attack** block
  running every cached-mode read path (objects, relationships, queries) over
  a marked Type, a marked member with computed values derived from it one
  and two levels deep, a relationship that is marked or points at a marked
  Type, adapter-protected fields, a value marked only in its provenance, and
  a protected override from a second data source (ADR-0023); a
  non-confidential cache ends up holding exactly the non-sensitive entries
  and none of the sensitive plaintext, while every read still returns every
  value; sensitive bundles read live each time; a cache that omits the flag,
  or claims it as `"true"` or `1`, is treated as not confidential; a
  confidential cache, `InMemoryCache` included, holds everything as before.
- `packages/encryption/test/encrypted-cache.test.ts` — round trips; the
  store holding neither values nor cache keys in the clear; fresh
  ciphertext per write; an **attack** block moving an entry to another
  key, tampering, extending the expiry, truncating, restoring an expired
  entry, and substituting a field envelope, a plaintext value, an entry
  under an unknown key, and one under different material with the same
  key id — each a miss, never a served value; the replay-within-TTL
  residual pinned; `delete` landing across a rotation; and, under the
  runtime over an `EncryptingAdapter`, a bare shared cache bypassed and
  empty, the same cache wrapped in `EncryptedCache` serving hits with no
  plaintext in it.
- `packages/redis/test/redis-cache-and-rate-limiter.test.ts` — `RedisCache`
  is not confidential, and (against real Redis, in CI) `EncryptedCache`
  over it round-trips while Redis holds neither the value nor the key.

Mutation-checked (21 mutations): trusting a cache that doesn't say
`confidential: true`; dropping any one of the bundle, relationship, or
computed rules (marked Type, marked member, adapter-protected field,
provenance marking, marked relationship, marked target, dependency
propagation); ignoring the bypass for computed values; `InMemoryCache` not
confidential; an `EncryptingAdapter` declaring nothing; and in
`EncryptedCache`, dropping the cache key or the expiry from the
authenticated data, skipping the expiry check, deleting under the active
key only, not declaring itself confidential, or storing cache keys in the
clear — each fails the suites.

## Context

The runtime's cache (ADR-0016) holds the adapter's raw output — property
bundles, relationship ref lists, computed values — before redaction, so one
entry serves every identity. That is the right design for *authorization*,
which runs fresh on every read. It is the wrong one for *confidentiality*
whenever the cache lives outside the process:

- An `EncryptingAdapter` (ADR-0033) decrypts on read, so a cached bundle of
  an encrypted Type is plaintext. With `RedisCache` (ADR-0025) configured,
  that plaintext lands in Redis — the store encryption at rest was meant to
  keep it out of, one hop away.
- Data marked SECRET (ADR-0032) is cached the same way, unmarked and in the
  clear, in whatever Redis the deployment runs.

ADR-0033 documented this ("don't cache encrypted Types") and review rightly
classed a documented rule as not good enough: nothing stops a Mapping from
saying `resolutionMode: "cached"`, and the leak is silent. The rule has to
be enforced where the cache is used — the runtime — and a deployment that
wants a shared cache for sensitive Types needs a way to have one.

## Decision

**1. Caches declare whether they are confidential.** `Cache` gains a
required `readonly confidential: boolean`: `true` means values it holds are
readable only by this process, or only under keys this process holds.
`InMemoryCache` is confidential (the plaintext is already in this process's
memory while it serves the read); `NoopCache` stores nothing and says so;
`RedisCache` is not. The runtime resolves the flag once at construction and
only `true` counts — a cache that omits it or says anything else is treated
as not confidential.

*Amended while verifying ADR-0038:* the runtime read `sensitiveFields`
synchronously, and the web demo's call-counting Proxy — like any decorator
that wraps methods as async — made it return a Promise, which the runtime
took to mean "no protected fields": computed values derived from encrypted
fields could have been cached in a non-confidential cache. A declaration may
now be async, and one that throws or answers anything but a list of names
protects every field of that adapter. Pinned by an **attack** block in
`packages/core/test/sensitive-caching.test.ts`.

**2. Adapters declare the fields they protect.** `Adapter` gains an optional
`sensitiveFields?(typeName): readonly string[]` — the fields it keeps
protected at rest. `EncryptingAdapter` returns its encrypted fields. An
adapter without the method protects nothing, which was already true. The
runtime asks the registered adapter itself, so the answer isn't routed
through the resilience wrapper.

**3. The runtime never puts a sensitive value in a cache that isn't
confidential.** A value is *sensitive* if any of these holds:

- its Type carries a marking (ADR-0032);
- its member carries a marking, or its stored value carries one in its
  provenance;
- an adapter behind the Type declares the field protected;
- it is a computed property whose declared dependencies (`dependsOn`,
  transitively) include a sensitive value.

A cached-mode read of sensitive data **bypasses** a non-confidential cache —
no `get`, no `set` — and reads live, exactly as a `"live"` Mapping would.
The unit of decision is the unit of caching, and it errs toward bypassing:

- a *property bundle* is everything one adapter returned for the object, so
  it bypasses if the Type or any of its members is marked, or that adapter
  protects any of the Type's fields; a bundle whose values arrive carrying a
  provenance marking is read but not stored;
- a *relationship's ref list* bypasses if its source Type, the relationship
  itself, or its target Type is marked — the list says which marked objects
  an object is linked to;
- a *computed value* bypasses by the rule above, decided per object from the
  bundle it was computed on.

The outcome shows up as `typesys.cache.requests{result="bypass"}`. A
confidential cache is used exactly as before, for everything.

**4. `EncryptedCache` makes any cache confidential.** In
`@typesys/encryption`, `new EncryptedCache(inner, keys)` wraps any `Cache` —
`RedisCache` is the case it's for — under the same `KeyProvider` as the
fields:

- each value is JSON-encoded and sealed with AES-256-GCM under its own HKDF
  subkey (`["tscache1", "aes-256-gcm"]`, separate from the field subkeys, so
  neither ciphertext can stand in for the other), with the cache key and the
  entry's expiry time as authenticated data — an entry moved to another key,
  or kept past the TTL it was written with, doesn't decrypt;
- the cache key itself is replaced by an HMAC under another subkey, so the
  store doesn't learn which Types and objects are being read;
- an entry that fails to decrypt — tampered, moved, expired, or under a key
  the ring doesn't hold — is a **miss**, reported to `onError`: the runtime
  reads live from the system of record, and nothing the store supplied is
  served;
- `delete` removes the entry under every key in the ring, so invalidation
  still works across a rotation; `get` and `set` use the active key.

## Consequences

- Plaintext of encrypted or marked data can no longer reach Redis through
  the runtime's cache. A deployment that cached such Types in Redis now reads
  them live, visibly in metrics, until it wraps the cache in `EncryptedCache`.
- `Cache` implementations must declare `confidential`. Nothing is published,
  so there are no external implementations to break.
- `EncryptedCache` values must be JSON-serializable, as with `RedisCache`.
- A Type with one marked field never caches its bundle in a non-confidential
  cache: the bundle holds that field. Computed values that don't depend on it
  still cache.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **Undeclared sensitivity isn't seen.** The rule covers markings in the
  schema and in provenance, and fields an adapter declares. An adapter that
  decrypts or holds sensitive data without declaring it — including a
  decorator wrapped *around* an `EncryptingAdapter` that doesn't forward
  `sensitiveFields` — is invisible to it; so is a computed property that
  reads sensitive data through `ctx.getAdapter` instead of `dependsOn`.
  Mark such a computed property itself.
- **Replay within the TTL.** `EncryptedCache` binds an entry to its key and
  expiry, not to its freshness: someone who can write the store can restore
  an entry that was invalidated or overwritten, and it is served until its
  original expiry. That is the staleness the TTL already allows, made
  deliberate; keep TTLs for sensitive Types short.
- **Rolling key rotation.** An instance can only remove entries under keys
  it holds; during a rotation, add the new key to every instance before
  making it active (ADR-0037), or entries written under it may outlive an
  invalidation from an instance that doesn't have it yet, until their TTL.
- **In-process means in-process.** `InMemoryCache` holds plaintext for the
  TTL, which widens what a heap dump or core file contains.

## Alternatives Considered

- **Keep documenting "don't cache encrypted Types."** The leak is silent and
  one field away; a rule nothing enforces is the thing review flagged.
- **Cache beneath the `EncryptingAdapter`, so the cache holds ciphertext.**
  Covers bundles, but not computed values derived from them, and doesn't help
  marked data, which is never encrypted.
- **Refuse to construct a runtime with a non-confidential cache when some
  Type is sensitive.** The registry is dynamic (Types register after
  construction and are shared across replicas), so construction can't know;
  and a refusal would turn "some Types can't use Redis" into "no Type can."
- **Throw instead of bypassing.** A cached-mode Mapping is a performance
  hint, and a live read is always correct; failing the read would trade an
  outage for no security gain. The bypass is visible in metrics.
- **Strip sensitive fields from a bundle and cache the rest.** A hit would
  then be a partial bundle the runtime has to re-merge with a live read — a
  second resolution path for the same object, for a saving the bypass
  already gets from Types without sensitive fields.
