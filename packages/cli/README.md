# @typesys/cli

A declarative authoring front-end and codegen tool for TypeS — the DX pass
described in `docs/architecture.md`'s "extending the type system" notes.
Two things, both optional and additive: nothing about `@typesys/core`,
`registerType`, or `RegistryStore` changed to support this.

## Why this exists

Authoring a Type in TypeScript means knowing about `$id`, ULIDs, `allOf`
composition, and `RegisterTypeOptions` before you can define one field —
fine for a domain package that's going to grow for years (`domain-airforce`
still authors this way, deliberately), heavy for a small project's first
five types. This package adds a YAML front-end that compiles to exactly
the same `SemanticTypeSchema`/`RegisterTypeOptions` shapes `registerType()`
already takes, plus a generator that turns registered Types into real
TypeScript interfaces — the "generated client types" the original mission
brief called for and neither this package nor any other ever built until
now.

## Starting a new domain

```bash
npx typesys init ./fleet --name fleet
```

Scaffolds `fleet/00-example.yaml` (one Type, `extends: core.Asset`), an
empty `fleet/bindings.mjs`, and a `fleet/README.md` naming the exact two
commands to run next. Never overwrites an existing directory unless you
pass `--force`. See `docs/quickstart.md` in the main repo for the full
walkthrough from here to a queryable object.

## Authoring a Type in YAML

```yaml
# fleet/10-vehicle.yaml
name: fleet.Vehicle
version: 1.0.0
extends: core.Asset
traits: [Trackable, Maintainable]

properties:
  plateNumber: { type: string }
  fuelType: { type: string, enum: [gasoline, diesel, electric] }
required: [plateNumber]

relationships:
  depot:
    target: core.Location
    cardinality: one-to-one
    resolution: { dataSourceId: fleet-repo, operation: "byOwnField:depotId" }

computed:
  utilizationRate:
    dependsOn: [maintenanceStatus]
    binding: computeUtilizationRate

policy:
  objectPolicy: fleet.read-vehicle
  propertyPolicies:
    maintenanceStatus: fleet.maintainer-only
```

Register a whole directory:

```ts
import { SemanticRegistry, InMemoryRegistryStore, coreManifest, coreTraits, registerDomain } from "@typesys/core";
import { registerYamlTypesFromDirectory } from "@typesys/cli";

const registry = new SemanticRegistry(new InMemoryRegistryStore());
await registerDomain(registry, coreManifest);
await registerYamlTypesFromDirectory(registry, "./fleet", {
  traitCatalog: coreTraits, // merge in your own domain's traits too
  computedImplementations: { computeUtilizationRate: async (ctx) => /* ... */ }
});
```

Files load in alphabetical order — the same "register base types before
subtypes that extend them" rule `registerType` itself enforces applies to
files too (hence `10-vehicle.yaml`, so a `00-something.yaml` it depends on
sorts first).

**Computed properties and preconditions still can't live in YAML** — only
`dependsOn`/`binding` do. `computedImplementations` supplies the real
function, exactly like registering in code, and exactly like a
`BindingRegistry` does for `@typesys/registry-store-postgres` (ADR-0015) —
same seam, same reason: YAML and databases hold data, processes supply
behavior.

## Generating TypeScript types

```bash
npx typesys generate-types ./fleet --bindings ./fleet/bindings.mjs --out ./fleet/types.generated.ts
```

Walks every currently-registered Type (core's types included) and emits
one `export interface` per Type — `extends BaseName` for the `extends`
chain, `extends TraitName` for each trait that contributes actual
properties, enums as string-literal unions, computed properties as fields.
Relationships and Actions are documented in a header comment, never
emitted as fields — inlining them would blur the exact "properties vs.
relationships vs. actions" distinction the rest of this system exists to
enforce (see `docs/adr/0003-relationships-as-first-class-records.md` and
`0005-actions-as-first-class-governed-capabilities.md`).

This is not a general JSON Schema → TypeScript compiler — it covers the
subset of JSON Schema this project's own schemas actually use (flat
primitives, enums, arrays of those, plus this project's own
`extends`/trait composition model). A generic converter would have no way
to know what `x-relationships`/`x-computed`/a registered-`$ref` `allOf`
even mean; this one is built around the meta-model directly, via the
registry's own `getType`/`getTraitSchema`, not by parsing raw schema JSON.

## Validating without generating

```bash
npx typesys validate ./fleet --bindings ./fleet/bindings.mjs
```

Registers everything and reports success/failure per the same rules
`registerType` already enforces (schema compiles, `extends` target exists,
traits are known, computed properties/preconditions have their bindings
supplied) — useful as a CI gate on a PR that only touches YAML files,
without needing to boot the rest of an application.

Add `--json` to any command (`init`, `validate`) for a single machine-
readable line instead of human-formatted text —
`{"ok":true,"dir":"...","types":[{"name":"...","version":"..."}]}` on
success, `{"ok":false,"error":"..."}` on failure — meant for CI or an
agent to parse directly rather than scraping prose. The exit code (0/1)
is set the same way either way.

## Programmatic API

`loadTypeYaml`, `registerYamlType`, `registerYamlTypesFromDirectory`,
`generateTraitInterface`, `generateTypeInterface`, and `generateModule` are
all exported from `@typesys/cli` directly — the CLI (`src/bin.ts`) is a
thin wrapper over the same functions, not a separate code path.
