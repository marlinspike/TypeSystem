# How to combine data from multiple sources

Your applications and your AI agents both need to ask "give me this
object, its related objects, and derived signals about it" without either
of them needing to know the answer actually lives across several systems.
There are three real, tested ways to do this in TypeS — reach for them in
this order.

## 1. Relationships across adapters — reach for this first

Model each source's data as its own Type, back each Type with its own
`Adapter`/`DataSource`, and connect them with `x-relationships`
([ADR-0006](../adr/0006-adapter-architecture.md)). This is proven, not
hypothetical: `packages/domain-airforce`'s `Aircraft`/`Component` live on
an in-memory repository adapter, `MaintenanceEvent`/`WorkOrder` live on a
mocked external REST system, and `Aircraft.components`/
`Aircraft.maintenance` relationships cross that boundary transparently.

```ts
"x-relationships": {
  maintenance: {
    target: "airforce.MaintenanceEvent",
    cardinality: "one-to-many",
    resolution: { dataSourceId: MAINTENANCE_DATA_SOURCE_ID, operation: "byForeignKey:aircraftId" }
  }
}
```

One `runtime.query({ type: "airforce.Aircraft", include: [{ relationship: "maintenance" }] })`
call returns a graph spanning both adapters. The consumer never knows or
cares which system backed which part. **Use this when the "other data" is
itself something a consumer would want to inspect, page through, or
navigate further from** — a related object, not a derived signal.

## 2. Cross-source computed properties — for a derived scalar, not a related object

A computed property's implementation function receives a `ComputeContext`
with `getProperty(name)` (values already resolved on this object) *and*
`getAdapter(dataSourceId)` — which reaches into **any** registered
adapter, not just the one backing this Type's own properties
([ADR-0022](../adr/0022-cross-source-computed-properties.md)).

Real, tested example — `Aircraft.needsAttention`
(`packages/domain-airforce/src/computed/needs-attention.ts`), combining
Aircraft's own `maintenanceStatus` with a live check against a completely
different system's `WorkOrder`s:

```ts
export async function computeNeedsAttention(ctx: ComputeContext): Promise<boolean> {
  const maintenanceStatus = await ctx.getProperty("maintenanceStatus"); // own source
  if (maintenanceStatus === "down" || maintenanceStatus === "degraded") return true;

  const maintenanceAdapter = ctx.getAdapter(MAINTENANCE_DATA_SOURCE_ID); // a different source entirely
  const events = await maintenanceAdapter.queryByType("airforce.MaintenanceEvent", {
    property: "aircraftId", operator: "eq", value: ctx.objectId
  });
  const eventIds = new Set(events.items.map((e) => e.objectId));
  const workOrders = await maintenanceAdapter.queryByType("airforce.WorkOrder");
  return workOrders.items.some((wo) => eventIds.has(wo.values.maintenanceEventId as string) && wo.values.status !== "closed");
}
```

Wire it in via `x-computed`/`computedImplementations`, exactly like any
other computed property (see
[`add-a-type.md`](add-a-type.md)). **Use this when the combined result is
a scalar/boolean/status — something baked into the object itself, not
something a consumer would separately navigate to.**

This isn't free, and `npm run benchmark` shows it honestly: unlike an
own-source computed property (`readinessStatus`), a cross-source one adds
a real, measured cost per object on the path it touches — `needsAttention`
alone made `airforce.Aircraft`'s filtered-query benchmark ~10x slower for
the "healthy" aircraft it can't short-circuit for (see ADR-0022's
Consequences). Measure a cross-source computed property on your own
high-cardinality query paths before assuming it's cheap.

## 3. Multi-source property composition — for literal fields split across systems

Sometimes an object's own fields, not a derived signal, are the thing
split across systems — most of an `Aircraft` lives in one repository, but
its `warrantyStatus` lives in a separate warranty-tracking system, keyed
by the same object id. Register a normal wildcard `Mapping` for the rest
of the Type, plus a *specific* per-property `Mapping` for the field that
lives elsewhere
([ADR-0023](../adr/0023-multi-source-property-composition.md)):

```ts
await registry.registerMapping({
  id: "map-aircraft-base", typeName: "fleet.Aircraft", target: "property", targetName: "*",
  dataSourceId: "fleet-repo", operation: "get", resolutionMode: "live"
});
await registry.registerMapping({
  id: "map-aircraft-warranty", typeName: "fleet.Aircraft", target: "property", targetName: "warrantyStatus",
  dataSourceId: "warranty-system", operation: "get", resolutionMode: "live"
});

const runtime = new SemanticRuntime(registry, [fleetAdapter, warrantyAdapter], policyEngine);
const aircraft = await runtime.getObject("fleet.Aircraft", "AC-001", identity, { includeProvenance: true });
// aircraft.values.warrantyStatus came from "warranty-system"; everything else came from "fleet-repo".
// aircraft.provenance finds warrantyStatus's source correctly named as "warranty-system", not "fleet-repo".
```

`getObject` and `query` both resolve the base bundle, then fan out
(bounded, concurrent) to every override's adapter and merge — an override
system with nothing for this object just leaves the base's value (or its
absence) untouched, no error. **Use this when the split is at the field
level on one object, not at the level of a whole related object or a
derived signal** — that's what patterns 1 and 2 are for.

A Type with no overrides (every Type in `domain-airforce`/`domain-hospital`
today) pays nothing for this — the override fan-out never runs at all.

## Which one, again

| You need... | Reach for... |
|---|---|
| A related object a consumer navigates to (paginated, filterable, inspectable on its own) | **Pattern 1** — relationships |
| A derived scalar/boolean baked into the object itself | **Pattern 2** — cross-source computed property |
| One object's own literal fields split across systems | **Pattern 3** — per-property Mapping override |

All three compose — nothing stops a Type from using all three at once,
the way `Aircraft` already uses patterns 1 and 2 together.

## Verify it

- Pattern 1: [`packages/domain-airforce/test/adapter-substitution.test.ts`](../../packages/domain-airforce/test/adapter-substitution.test.ts).
- Pattern 2: [`packages/domain-airforce/test/needs-attention-computed-property.test.ts`](../../packages/domain-airforce/test/needs-attention-computed-property.test.ts).
- Pattern 3: [`packages/core/test/multi-source-property-composition.test.ts`](../../packages/core/test/multi-source-property-composition.test.ts).
