# How to enable caching

Opt-in per `Mapping`, relationship, or computed property — nothing is
cached unless you ask for it ([ADR-0016](../adr/0016-caching.md)).

## Cache a property

```ts
await registry.registerMapping({
  id: "map-widget", typeName: "fleet.Widget", target: "property", targetName: "*",
  dataSourceId: "fleet-repo", operation: "get",
  resolutionMode: "cached",
  cacheTtlMs: 30_000   // optional — falls back to the runtime's defaultCacheTtlMs
});
```

## Cache a relationship

Add `resolutionMode`/`cacheTtlMs` to the relationship spec itself:

```ts
"x-relationships": {
  components: {
    target: "fleet.Part", cardinality: "one-to-many",
    resolution: { dataSourceId: "fleet-repo", operation: "byForeignKey:widgetId" },
    resolutionMode: "cached", cacheTtlMs: 60_000
  }
}
```

## Cache a computed property

```ts
"x-computed": {
  utilizationRate: { dependsOn: ["status"], binding: "computeUtilizationRate", resolutionMode: "cached", cacheTtlMs: 15_000 }
}
```

## Wire up the cache itself

The `cache` and `defaultCacheTtlMs` fields of `SemanticRuntime`'s options (its 4th argument) — omit either and
caching is a true no-op (a `NoopCache` that always misses), so adding
this to an existing runtime is always safe to try incrementally:

```ts
import { SemanticRuntime, InMemoryCache } from "@typesys/core";

const runtime = new SemanticRuntime(registry, adapters, policyEngine, {
  cache: new InMemoryCache(), // omit for pre-ADR-0016 "always live" behavior
  defaultCacheTtlMs: 30_000   // used when a mapping has no cacheTtlMs of its own
});
```

## What actually gets cached

The adapter's **raw** output — before property-level policy redaction.
One cache entry correctly serves every identity; each identity's
redaction still runs fresh on every read. Never worry about a cache bug
leaking one identity's view to another — the cache sits entirely on the
"resolve" side, redaction entirely on the "respond" side.

If a Type uses per-property `Mapping` overrides from other `DataSource`s
(multi-source property composition, [ADR-0023](../adr/0023-multi-source-property-composition.md),
see [`combine-multiple-sources.md`](combine-multiple-sources.md)), each
mapping's `resolutionMode`/`cacheTtlMs` is independent — the base bundle
and each override cache (or don't) on their own terms, keyed by their own
`dataSourceId`. `invalidateObject` clears all of them together.

## Sensitive data stays out of shared caches

Every `Cache` says whether it is `confidential`, and the runtime never puts
sensitive values in one that isn't
([ADR-0036](../adr/0036-sensitive-data-caching.md)). Sensitive means marked
(the Type, the member, or the value's provenance, ADR-0032), in a field an
adapter protects (an `EncryptingAdapter`'s encrypted fields), or computed
from any of those through `dependsOn`. Such a read skips the cache and goes
live; the metric `typesys.cache.requests` counts it as `result="bypass"`.

`InMemoryCache` is confidential; `RedisCache` isn't. Wrap a shared cache in
`EncryptedCache` from `@typesys/encryption` to cache sensitive Types in it
(see [`encrypt-fields.md`](encrypt-fields.md#caching)). A computed property
that reads sensitive data through `ctx.getAdapter` rather than `dependsOn`
isn't seen by this rule — mark it.

## Invalidate manually

TTL alone, not event-driven invalidation, is the whole story here — see
ADR-0016's "Alternatives Considered" for why. If your code just wrote
fresh data and can't wait out the TTL:

```ts
await runtime.invalidateObject("fleet.Widget", "widget-1");
```

Clears that object's cached properties, every relationship's cached
ref list, and every cached computed-property value — all in one call.

## `InMemoryCache` is per-process

Two runtime instances (two replicas) cache independently, so one
replica's `invalidateObject` never reaches the other. For more than one
instance, use `RedisCache` from `@typesys/redis`: every replica shares
the entries and the invalidations; see
[`run-multiple-instances.md`](run-multiple-instances.md). Or implement the
`Cache` interface (`packages/core/src/runtime/cache.ts`) yourself — four
methods and the `confidential` flag.

## Verify it

Follow [`packages/core/test/caching.test.ts`](../../packages/core/test/caching.test.ts) —
a counting adapter proves the second call within the TTL never touches
it, a short TTL + a real sleep proves expiry, and one test proves the
per-identity-redaction-stays-fresh property directly.
[`sensitive-caching.test.ts`](../../packages/core/test/sensitive-caching.test.ts)
runs every read path against a non-confidential cache and checks it ends up
holding nothing sensitive.
