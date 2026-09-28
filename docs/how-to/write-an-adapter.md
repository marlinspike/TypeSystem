# How to write an adapter

An `Adapter` is the only thing separating "what a Type is" from "where its
data actually lives" ([ADR-0006](../adr/0006-adapter-architecture.md)).
Implement four methods
([`packages/core/src/runtime/adapter.ts`](../../packages/core/src/runtime/adapter.ts)):

```ts
export interface Adapter {
  readonly dataSourceId: string;
  resolveProperties(typeName: string, objectId: string, propertyNames: string[]): Promise<ResolvedProperties>;
  queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string): Promise<AdapterQueryResult>;
  resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string): Promise<RelatedRef[]>;
  executeAction(action: ActionDefinition, input: unknown, ctx: ActionContext): Promise<unknown>;
}
```

Two real, complete implementations to copy from — pick whichever is
closer to your real backend:

- [`packages/adapter-in-memory/src/in-memory-repository-adapter.ts`](../../packages/adapter-in-memory/src/in-memory-repository-adapter.ts) —
  a repository/database-shaped backend (one record per object id).
- [`packages/adapter-mock-rest/src/mock-rest-adapter.ts`](../../packages/adapter-mock-rest/src/mock-rest-adapter.ts) —
  an external-system-shaped backend with its *own* field names
  (`aircraft_tail`, not `aircraftId`) that the adapter translates.

## The four methods, concretely

**`resolveProperties`** — return every property this adapter owns for one
object, as canonical (camelCase, this project's own naming) values, plus
a `ProvenanceRef` per field:

```ts
async resolveProperties(typeName, objectId): Promise<ResolvedProperties> {
  const record = await this.fetchFromRealBackend(objectId);
  const values = { id: record.id, status: record.status_code }; // translate field names here
  return {
    values,
    provenance: Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: this.dataSourceId, system: "MyRealBackend", recordId: objectId, field },
      retrievedAt: new Date().toISOString(),
      confidence: 1
    }))
  };
}
```

Real adapters typically ignore the `propertyNames` filter and return
everything — that's fine, and is what both shipped adapters do (a real
REST `GET` or DB read usually returns a whole row/document anyway).

**`queryByType`** — same values shape, for every matching object; use
`matchesFilter` from `@typesys/core` if your backend can't filter
server-side (both shipped adapters do this):

```ts
import { matchesFilter } from "@typesys/core";
const all = await this.fetchAllFromRealBackend();
const filtered = filter ? all.filter((v) => matchesFilter(v, filter)) : all;
```

The runtime always passes a concrete `limit` (the caller's, or
`QueryLimits.defaultLimit`; see
[`enable-rate-limiting-and-concurrency-bounds.md`](enable-rate-limiting-and-concurrency-bounds.md#bound-how-much-one-query-can-ask-for)).
Return at most that many items, and a `nextCursor` whenever more remain,
or callers can never reach page two.

**`resolveRelationship`** — interpret `relationship.resolution.operation`
yourself (see [`add-a-relationship-and-action.md`](add-a-relationship-and-action.md)
for the two conventions already in use) and return just the related
object ids — the runtime calls `getObject` on each one for you, concurrently.

**`executeAction`** — match on `action.implementation.operation`, do the
real write, return the result. This is the *only* place a side effect
happens; the runtime already ran the policy check, validated `input`
against the Action's `inputSchema`, and ran preconditions before calling
you.

## Wire it in

```ts
const adapter = new MyAdapter("my-datasource-id");
await registry.registerDataSource({ id: "my-datasource-id", name: "My Backend", kind: "custom" });
await registry.registerMapping({
  id: "map-widget", typeName: "fleet.Widget", target: "property", targetName: "*",
  dataSourceId: "my-datasource-id", operation: "get", resolutionMode: "live"
});
const runtime = new SemanticRuntime(registry, [adapter, /* your other adapters */], policyEngine);
```

Two Types can use two completely different adapters and the runtime never
branches on which — that substitutability is the whole point, proven by
[`packages/domain-airforce/test/adapter-substitution.test.ts`](../../packages/domain-airforce/test/adapter-substitution.test.ts).

## Verify it

Write the same shape of test: seed your adapter, register a Type +
Mapping pointing at it, call `runtime.getObject`/`query`/`getRelationship`,
assert on the values. No mocking of the runtime itself needed — the
adapter is the only thing under test.
