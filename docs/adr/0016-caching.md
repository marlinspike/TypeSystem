# 0016. Cached Resolution Mode

## Status

Accepted

## Context

ADR-0007 defined `ResolutionMode` as `"live" | "materialized" | "cached"`
but left `"cached"` deliberately inert: "there is no cache layer, cache
invalidation policy, or TTL mechanism anywhere in this codebase... do not
describe `"cached"` as implemented in any consumer-facing material." That
ADR also named the reason it wasn't built yet: a cache needs an
invalidation story worked out *before* it's built, or it becomes the next
thing that has to be explained away.

At scale, the gap is real: every property/relationship read re-calls the
adapter, every time, even for data that changes rarely (a `core.Location`,
a `DataSource` definition, an Aircraft's static `model` field). The
mission brief's own non-goals rule out one obvious answer — "do NOT
attempt to build a gigantic reactive DAG engine" for invalidation — so the
design has to find a genuinely small, honest answer, not back into a big
one.

## Decision

### A `Cache` interface, swappable like every other seam in this system

```ts
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
```

(`packages/core/src/runtime/cache.ts`). `InMemoryCache` (a `Map` with
per-entry expiry) is the only implementation built. `SemanticRuntime`
takes an optional `cache?: Cache` constructor argument — omit it and
`NoopCache` is used, which always misses, so every existing caller/test
that never opted in behaves *exactly* as before (fully backward
compatible; this is why no existing test needed to change).

A distributed cache (Redis, Memcached) is a documented, not-built
extension point — same shape of decision as `RegistryStore` before
ADR-0015's Postgres implementation existed. `InMemoryCache` is per-process;
see Consequences for what that means for multi-instance deployments.

### Cache the adapter's raw output, never a policy-filtered view

The cached value is always what `Adapter.resolveProperties`/
`resolveRelationship` returned — before property-level redaction
(`SemanticRuntime.finalizeValues`) is applied. Redaction runs fresh, every
call, on top of whatever came out of the cache. This means:

- One cache entry correctly serves every identity — a viewer and a
  maintainer reading the same Aircraft share the same cached raw values;
  each still gets their own correctly-redacted view.
- Caching can never leak a property one identity shouldn't see into
  another identity's response — the cache sits entirely on the
  "resolve" side of the boundary, policy enforcement sits entirely on the
  "respond" side, and those two things staying separate is exactly ADR-0009's
  point.

### TTL-based expiry, not event-driven invalidation

Every cached entry has a time-to-live: `Mapping.cacheTtlMs` /
`ComputedPropertyDefinition.cacheTtlMs` (both new, optional fields) name
it per-mapping/per-computed-property; `SemanticRuntime`'s
`defaultCacheTtlMs` constructor option (default 30 000 ms) is the fallback
when neither specifies one. `resolutionMode` must be `"cached"` for any of
this to apply — `"live"` mappings are untouched, exactly as before.

For cases where a caller knows it just changed something and 30 seconds
of staleness is unacceptable, `SemanticRuntime.invalidateObject(typeName,
objectId)` clears every cache entry that exists about that object — its
property bundle, every relationship's cached ref list, every computed
property's cached value. This is a deliberate, manual escape hatch, not
automatic invalidation wired into `invokeAction`: an Action's `input`
doesn't reliably tell the runtime which object(s) it affected (a
`maintenanceEventId` field is a convention, not a contract), so guessing
would produce occasionally-wrong invalidation that's worse than
predictable, bounded staleness. Call `invalidateObject` explicitly
wherever your code knows it wrote fresh data.

### Scope: property and relationship resolution only

`getObject` and `getRelationship` are cache-aware. `query` (`queryByType`)
and `invokeAction` are not, and will not be reconsidered without a
separate decision:

- A query's cache key would need to encode its filter/include/pagination
  shape — a much larger, differently-shaped cardinality problem than
  "one entry per object," and one this pass doesn't need to solve to make
  caching real.
- Actions have side effects by definition (ADR-0005) — caching a write is
  not a caching problem, it's a correctness bug.

## Consequences

- Staleness is bounded by `cacheTtlMs` for anything relying on expiry
  alone, and unbounded until `invalidateObject` is called for anything
  relying on manual invalidation — both are visible, documented tradeoffs,
  not surprises.
- Multi-instance deployments get **per-process** cache consistency:
  replica A and replica B each cache independently, so a write visible to
  A may not be reflected in B's cache until A's TTL expires (or nobody
  calls `invalidateObject` on B). This is acceptable for the same reason
  ADR-0015 accepted an unverified-at-scale multi-instance story for
  `PostgresRegistryStore`: nothing in this codebase currently runs more
  than one instance, and the `Cache` interface is exactly the seam a
  distributed implementation would slot into later without touching
  `SemanticRuntime`.
- Opt-in per `Mapping`/`ComputedProperty`, never a global default: setting
  `resolutionMode: "cached"` is a decision the Type/domain author makes
  about *that* property, not something the runtime does silently. Data
  that must always be fresh keeps `"live"` and pays for it.

## Alternatives Considered

- **Event-driven invalidation** (a change stream, pub/sub, or the
  "Aircraft.engineHours changed → FailureRisk stale → recompute" chain
  sketched in the mission brief's "Events and change propagation"
  section): rejected for this pass, explicitly, per that same section's
  own instruction not to build "a gigantic reactive DAG engine" in the
  first iteration. TTL + manual `invalidateObject` is the honest amount of
  invalidation machinery this pass needs; the clean seam for something
  richer later is `Cache` itself, not a rewrite of it.
- **Caching enabled by default for every `Mapping`**: rejected — silently
  caching data an author never opted into risks serving stale reads for
  properties where that's actually wrong (anything security- or
  freshness-sensitive). Opt-in per mapping keeps the failure mode "you
  forgot to enable caching" (slow but correct) rather than "you got stale
  data you didn't ask for" (fast but wrong).
- **Caching the per-identity redacted view** (keyed by
  `objectId + identity`): rejected — multiplies cache entries by the
  number of distinct identities touching the same object for no benefit,
  and risks a real security bug if a caching bug ever served identity A's
  cached (and correctly redacted, at cache-write time) response to
  identity B before policy re-evaluates. Caching pre-redaction and always
  re-redacting on read makes that entire bug class structurally
  impossible.
- **Auto-invalidating on `invokeAction`**: rejected — see Decision above;
  guessing which object(s) an action's `input` refers to is unreliable
  enough that it would trade predictable staleness for occasional silent
  incorrectness, which is a worse failure mode.
