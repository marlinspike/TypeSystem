# How to add a Type

Two authoring paths exist — pick one per Type, not per project:

- **YAML** (via `@typesys/cli`) — faster to write, good for a new/small
  domain. See [`quickstart.md`](../quickstart.md).
- **TypeScript** — full type-checking on the schema itself, the pattern
  every file in `packages/domain-airforce/src/types/` uses. Use this once
  a domain is going to live for years, or needs a computed property/
  precondition (which YAML can declare but never implement — see below).

## TypeScript path

```ts
// packages/domain-<yours>/src/types/widget.ts
import type { DomainTypeEntry } from "@typesys/core";

export const WidgetType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/fleet/Widget/1.0.0",
    title: "Widget",
    description: "A tracked fleet item.",
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "retired"] }
    },
    required: ["status"],
    "x-policy": { objectPolicy: "fleet.read-widget" }
  },
  options: {
    name: "fleet.Widget",
    version: "1.0.0",
    extends: "core.Asset",       // optional, single level only — ADR-0004
    traits: [TrackableTrait]      // optional, imported from "@typesys/core"
  }
};
```

Register it in your domain's manifest (`packages/domain-<yours>/src/manifest.ts`,
following `packages/domain-airforce/src/manifest.ts`): base types before
anything that `extends` them, in the `types` array. `registerDomain()`
registers them in that order.

## YAML path

```yaml
# fleet/10-widget.yaml
name: fleet.Widget
version: 1.0.0
extends: core.Asset
traits: [Trackable]
properties:
  status: { type: string, enum: [active, retired] }
required: [status]
policy:
  objectPolicy: fleet.read-widget
```

Full field reference: `packages/cli/src/yaml-loader.ts`'s
`YamlTypeDocument` interface — every field maps 1:1 to a
`SemanticTypeSchema`/`RegisterTypeOptions` field of the same name.

## Adding a computed property (either path)

Declare the shape in the schema/YAML; supply the real function separately
— a Type definition can name a computed property, but never implement it,
because the implementation is a function and functions aren't data (see
[ADR-0015](../adr/0015-postgres-registry-store.md), which this same
pattern comes from):

```yaml
computed:
  utilizationRate:
    dependsOn: [maintenanceStatus]
    binding: computeUtilizationRate   # a *name*, not the function
    resolutionMode: live               # or "cached" — see enable-caching.md
```

```ts
// TypeScript path: pass it directly to registerType's options
computedImplementations: { computeUtilizationRate: async (ctx) => { /* ... */ } }

// YAML path: pass it to the loader
await registerYamlTypesFromDirectory(registry, "./fleet", {
  computedImplementations: { computeUtilizationRate: async (ctx) => { /* ... */ } }
});
```

`ctx.getProperty(name)` reads another (already-resolved) property or
computed value on the same object; `ctx.getAdapter(dataSourceId)` reaches
an adapter directly if you need to look something up elsewhere — including
a completely different `DataSource` than the one backing this Type's own
properties. `Aircraft.needsAttention`
(`packages/domain-airforce/src/computed/needs-attention.ts`) is a real,
tested example combining both in one computed property — see
[ADR-0022](../adr/0022-cross-source-computed-properties.md) and
[`combine-multiple-sources.md`](combine-multiple-sources.md) for when to
reach for this instead of a relationship.

## Verify it

```bash
npx tsx packages/cli/src/bin.ts validate ./fleet --bindings ./fleet/bindings.mjs
```

or, for the TypeScript path, write a test following
`packages/core/test/trait-merge.test.ts` — register the type against a
fresh `InMemoryRegistryStore`, then assert on the returned
`TypeDefinition`.
