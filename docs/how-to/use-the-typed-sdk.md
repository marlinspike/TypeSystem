# How to use the typed SDK

`@typesys/sdk` gives an application or agent harness a client typed by your
model: Type, property, relationship and Action names are checked by the
compiler, rows are typed, and every query still goes to the runtime as an
ordinary `SemanticQuery`, decided per caller
([ADR-0055](../adr/0055-typed-sdk-generated-from-the-registry.md)).

## 1. Generate the model

The model is generated from the registry, so it covers `extends`, traits,
computed properties and Actions exactly as the registry composed them.

For a YAML domain:

```bash
npx typesys generate-sdk ./fleet --bindings ./fleet/bindings.mjs --name FleetModel --out ./src/fleet-model.ts
npx typesys generate-sdk ./fleet --bindings ./fleet/bindings.mjs --name FleetModel --out ./src/fleet-model.ts --check   # in CI
```

For a TypeScript domain, call the generator on a registry you have built:

```ts
import { describeModel } from "@typesys/core";
import { generateModel } from "@typesys/sdk";

const code = generateModel(await describeModel(registry, { prefixes: ["airforce."] }), { name: "AirforceModel" });
```

The demo domains commit theirs (`packages/domain-*/src/model.generated.ts`);
`npm run sdk:models` regenerates them and `npm run sdk:models -- --check`
fails if one has drifted.

Give each computed property a value `schema` so it is typed; without one
it is `unknown`. The runtime checks every computed value against it.

```ts
"x-computed": {
  needsAttention: { dependsOn: ["maintenanceStatus"], binding: "computeNeedsAttention", schema: { type: "boolean" } }
}
```

## 2. Make a client

```ts
import { createClient, runtimeTransport, mcpTransport } from "@typesys/sdk";
import type { AirforceModel } from "@typesys/domain-airforce";

// In process, as one caller:
const af = createClient<AirforceModel>(runtimeTransport(runtime, identity));

// Or against a TypeS MCP server, with any client that has callTool():
const remote = createClient<AirforceModel>(mcpTransport(mcpClient, { authToken }));
```

## 3. Query

```ts
const page = await af
  .from("airforce.Aircraft")
  .where((a) => a.needsAttention.eq(true))       // computed: runs in the runtime (ADR-0054)
  .where({ model: "F-16C" })                      // stored: runs in the source system
  .select("tailNumber", "readinessStatus")
  .include("components", (c) => c.select("partNumber").where((x) => x.condition.in(["fair", "poor"])))
  .page();

for (const aircraft of page.items) {
  aircraft.tailNumber;                  // string | undefined
  aircraft.components[0]?.partNumber;   // string | undefined
}
```

Every value is optional: policy may withhold any of them from this caller.
`page()` returns one page and its `nextCursor`; `all()` iterates every page;
`first()` returns the first row; `explain()` returns the execution plan
without running the query; `toQuery()` returns the `SemanticQuery` itself.

Filters: `eq`, `ne` and `in` on every value; `gt`, `gte`, `lt`, `lte` on
numbers; `icontains` on strings; `contains` on arrays. `and()`, `or()` and
`fields<Model, Type>()` build reusable filters. A top-level `orderBy`
takes stored properties only; an include's may name a computed one.

## 4. Read, and act

```ts
await af.get("airforce.Aircraft", "AF86-0147", { provenance: true });
await af.related("airforce.Aircraft", "AF86-0147", "components");
await af.provenance("airforce.Aircraft", "AF86-0147", "needsAttention");

await af.actions("airforce.WorkOrder", workOrderId);              // what this caller may do to this object
await af.action("UpdateWorkOrderStatus").preview({ workOrderId, status: "closed" });  // nothing executes
await af.action("UpdateWorkOrderStatus").invoke({ workOrderId, status: "closed" });
```

## From a query to code

`querySource` turns any `SemanticQuery` (one composed in TypeS Studio,
proposed by an agent or found in a log) into the code that builds it:

```ts
import { querySource } from "@typesys/sdk";

querySource({ type: "airforce.Aircraft", filter: { property: "needsAttention", operator: "eq", value: true }, limit: 5 }, { client: "af" });
// af.from("airforce.Aircraft")
//   .where((f) => f.needsAttention.eq(true))
//   .limit(5)
```

Running that code builds the same query; a cursor is left out, since it
belongs to `page()`.

## Errors

In process, the runtime's own errors reach you (`AuthorizationError`,
`InvalidInputError`, `ComputedValueError`, ...). Over MCP a refusal is a
`RemoteToolError` carrying the server's message, since MCP tool errors carry
only text.

## Verify it

[`packages/sdk/test/types.test.ts`](../../packages/sdk/test/types.test.ts)
holds the compile-time checks (run `npm run typecheck`);
[`client.test.ts`](../../packages/sdk/test/client.test.ts) shows the SDK
returning exactly what the runtime returns, in process and over MCP.
