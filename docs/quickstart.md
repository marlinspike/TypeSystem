# Quickstart

Ten minutes from a clean clone to a query result, using the declarative
YAML path (`@typesys/cli`) — the friendliest on-ramp for a new project.
If you're adding to an *existing* TypeScript domain package instead
(like `domain-airforce`), see
[`developer-guide/adding-a-domain.md`](developer-guide/adding-a-domain.md)
instead — it's the same underlying model, authored directly in code.

Every command below is copy-pasteable and has actually been run against
this exact repository.

## 0. Install

```bash
git clone <this-repo> && cd TypeS
npm install
```

## 1. Scaffold a domain

```bash
npx tsx packages/cli/src/bin.ts init ./fleet --name fleet
```

```
Scaffolded "fleet" in ./fleet:
  ./fleet/00-example.yaml
  ./fleet/bindings.mjs
  ./fleet/README.md

Next: npx typesys validate ./fleet --bindings ./fleet/bindings.mjs
```

Open `fleet/00-example.yaml`. It's a real, complete Type definition:

```yaml
name: fleet.Widget
version: 1.0.0
title: Widget
extends: core.Asset
traits: [Trackable]

properties:
  status:
    type: string
    enum: [active, retired]
required: [status]

policy:
  objectPolicy: fleet.read-widget
```

`extends: core.Asset` and `traits: [Trackable]` mean `fleet.Widget`
already has `id`, `name`, `description` (from `core.Asset`) and
`trackingId`, `lastTrackedAt` (from the `Trackable` trait) — you get
those for free from a one-level `extends` plus a trait mix-in (see
[ADR-0004](adr/0004-composition-via-allof-not-dynamicref.md)).

## 2. Validate it

```bash
npx tsx packages/cli/src/bin.ts validate ./fleet --bindings ./fleet/bindings.mjs
```

```
OK — 1 type(s) registered from ./fleet:
  fleet.Widget@1.0.0
```

This actually registers the Type against a real `SemanticRegistry` (core's
own types included) and reports the same errors `registerType()` would —
an unknown trait, a missing `extends` target, an unregistered computed-
property binding — before anything else in your project has to catch them.

## 3. Generate TypeScript types for it

```bash
npx tsx packages/cli/src/bin.ts generate-types ./fleet --bindings ./fleet/bindings.mjs
```

```ts
export interface Trackable {
  trackingId?: string;
  lastTrackedAt?: string;
}

export interface Asset {
  id: string;
  name: string;
  description?: string;
}

/**
 * fleet.Widget@1.0.0 — A placeholder Type — rename or delete once you have a real one.
 */
export interface Widget extends Asset, Trackable {
  status: "active" | "retired";
}
```

(Core's other types — `Party`, `Person`, `Organization`, `Location`,
`Event` — are always included too; trimmed here for length. Add `--out
./fleet/types.generated.ts` to write the file instead of printing it.)

## 4. Actually retrieve one

Registering a Type is only half the picture — you also need a `Mapping`
telling the runtime *where* a `fleet.Widget`'s properties actually live,
and an `Adapter` that can fetch them. This step uses the in-memory
adapter (`@typesys/adapter-in-memory`) so there's no real backend to set
up yet:

```ts
// query.ts
import {
  SemanticRegistry, SemanticRuntime, InMemoryRegistryStore,
  AbacPolicyEngine, allowAllRule, coreManifest, coreTraits, registerDomain
} from "@typesys/core";
import { registerYamlTypesFromDirectory } from "@typesys/cli";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";

const registry = new SemanticRegistry(new InMemoryRegistryStore());
await registerDomain(registry, coreManifest);
await registerYamlTypesFromDirectory(registry, "./fleet", { traitCatalog: coreTraits });

const adapter = new InMemoryRepositoryAdapter("fleet-repo");
adapter.seed("fleet.Widget", [
  { objectId: "widget-1", values: { id: "widget-1", name: "First Widget", status: "active" } }
]);

await registry.registerMapping({
  id: "map-widget", typeName: "fleet.Widget", target: "property", targetName: "*",
  dataSourceId: "fleet-repo", operation: "get", resolutionMode: "live"
});

const policyEngine = new AbacPolicyEngine();
policyEngine.registerRule("fleet.read-widget", allowAllRule); // wide open for this demo — see how-to/add-a-policy-rule.md for real rules

const runtime = new SemanticRuntime(registry, [adapter], policyEngine);

const identity = { subjectId: "me", roles: [], attributes: {} };
console.log(await runtime.getObject("fleet.Widget", "widget-1", identity));
```

```bash
npx tsx query.ts
```

```json
{
  "typeName": "fleet.Widget",
  "objectId": "widget-1",
  "values": { "id": "widget-1", "name": "First Widget", "status": "active" }
}
```

That's the whole loop: a declarative Type, a real registry, a real
(in-memory, for now) adapter, and a policy-gated read — the same shape
every step of a production deployment scales up from.

## Where to go next

- **Add a real relationship and Action** →
  [`how-to/add-a-relationship-and-action.md`](how-to/add-a-relationship-and-action.md)
- **Point at a real backend instead of the in-memory adapter** →
  [`how-to/write-an-adapter.md`](how-to/write-an-adapter.md)
- **Turn on durable persistence** →
  [`how-to/use-postgres.md`](how-to/use-postgres.md)
- **Let an AI agent use this domain over MCP** →
  [`for-agents.md`](for-agents.md)
- **See the whole thing running** → `npm run demo` (http://localhost:4000)
  or `npm run smoke:mcp` from the repo root.
- **Understand why any of this is shaped this way** →
  [`why-typesys.md`](why-typesys.md) and [`docs/adr/`](adr/).
