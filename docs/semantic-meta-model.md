# Semantic Meta-Model

This document specifies the canonical semantic meta-model implemented in
`packages/core/src/model/*.ts`. Every field named below is a real field in
the source — nothing here is aspirational. Each section ends with a worked
example from `packages/domain-airforce`.

## Type

A `Type` is "what something IS": its identity, its structural shape, and the
relationships/actions/computed-properties/policy/provenance it declares.

Two related shapes exist:

- **`TypeIdentity`** (`model/type.ts`) — the stable identity a `Type`
  carries independent of its authored content: `id` (registry-assigned
  ULID), `name` (the namespaced logical name a consumer references, e.g.
  `"airforce.Aircraft"`), `version` (semver), `extends?` (single level only
  — no deep inheritance chains), `traits?` (trait names).
- **`TypeDefinition`** (`model/type.ts`) — what the registry actually
  stores after composition: `TypeIdentity` plus `description?`, `schema`
  (the composed `SemanticTypeSchema`), `relationships`
  (`RelationshipDefinition[]`, materialized from `x-relationships` at
  registration time — never re-parsed at query time),
  `actionNames` (`string[]`), `computedProperties`
  (`ComputedPropertyDefinition[]`), `deprecated?` (`{since, supersededBy?,
  sunsetAt?}`), `aliases?` (`Record<oldName, newName>`).

A Type is authored as a plain object literal — a `DomainTypeEntry`
(`{schema, options}`) — not a separate DSL file. `schema` is a
`SemanticTypeSchema` (see Property below); `options` is a
`RegisterTypeOptions` (`name`, `version`, `extends?`, `traits?`,
`computedImplementations?`, `deprecated?`, `aliases?`) passed to
`registry.registerType(schema, options)`.

Resolution/enforcement: `SemanticRegistry.registerType()` validates the
composed schema against Ajv 2020-12, merges relationships/actionNames/
computed properties from `extends` < traits < own (own wins on name
collision), and persists the flattened `TypeDefinition` via `RegistryStore`.
`SemanticRuntime` never touches the raw schema's `x-*` keywords directly —
it reads `typeDef.relationships`, `typeDef.computedProperties`, and
`typeDef.schema["x-policy"]` (the one place policy is still read off the
schema, since policy is per-Type but not merged into a separate top-level
field).

**Worked example** — `airforce.Aircraft`
(`packages/domain-airforce/src/types/aircraft.ts`):

```ts
export const AircraftType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/airforce/Aircraft/1.0.0",
    title: "Aircraft",
    type: "object",
    properties: { tailNumber: { type: "string" }, model: { type: "string" } },
    required: ["tailNumber", "model"],
    "x-relationships": { /* components, maintenance — see Relationship below */ },
    "x-computed": { /* readinessStatus — see ComputedProperty below */ },
    "x-policy": { objectPolicy: "airforce.read-aircraft", propertyPolicies: { maintenanceStatus: "airforce.maintainer-only" } }
  },
  options: {
    name: "airforce.Aircraft",
    version: "1.0.0",
    extends: "core.Asset",
    traits: [TrackableTrait, MaintainableTrait],
    computedImplementations: { computeReadinessStatus }
  }
};
```

## Property (JSON Schema + the `x-*` vocabulary)

There is no separate `PropertyDefinition` type in this codebase. A
property is an ordinary JSON Schema 2020-12 property entry under
`schema.properties`, validated with Ajv (`ajv 8.20.0`, `Ajv2020` build,
`ajv-formats` for `format` keywords like `date-time`/`email`). The
project layers a private vocabulary on top of 2020-12 —
`SemanticTypeSchema` (`model/vocabulary.ts`), under vocabulary URI
`https://typesys.dev/vocab/semantic/v1` — adding six `x-*` keywords that
plain JSON Schema has no concept of:

- `x-relationships`: `Record<name, XRelationshipSpec>` where
  `XRelationshipSpec = { target, cardinality, inverse?, description?,
  edgeSchema?, resolution: {dataSourceId, operation} }`.
- `x-actions`: `{ actions: string[] }` — names of `ActionDefinition`s
  applicable to this Type.
- `x-computed`: `Record<name, XComputedSpec>` where `XComputedSpec = {
  dependsOn: string[], binding: string, resolutionMode?: "live" |
  "materialized" | "cached" }`.
- `x-policy`: `{ objectPolicy?: string, propertyPolicies?: Record<name,
  policyName> }`.
- `x-provenance`: `{ defaultClassification?: string, properties?:
  Record<name, {authoritativeSource?: string}> }`.
- `x-metadata`: `{ owner?: string, tags?: string[], [key: string]: unknown }`.

These keywords are authoring sugar: the Registry parses them once at
registration time into first-class records (`RelationshipDefinition[]`,
`ComputedPropertyDefinition[]`, etc.) that the Runtime consumes directly.
`x-provenance` and `x-metadata` are declared in the vocabulary and
compiled without error, but the Runtime does not currently read them back
out anywhere — they are present as authoring-time annotation space, not
wired into a behavior in this pass.

Enforcement gotcha, and its fix: Ajv's default `strict: true` mode throws
on unrecognized keywords, so the very first schema compile would fail on
`x-relationships` etc. `createSemanticValidator()`
(`packages/core/src/registry/validation.ts`) calls `ajv.addKeyword(keyword)`
for each of the six `SEMANTIC_X_KEYWORDS` — the string-form call registers
an annotation-only keyword — before any `SemanticTypeSchema` is compiled.
Get this wrong (wrong order, or a keyword left out) and registration of the
first type throws.

**Worked example** — `airforce.Component`'s `condition` property
(`packages/domain-airforce/src/types/component.ts`): a plain enum-constrained
string, `{ type: "string", enum: ["good", "fair", "poor"] }`, validated by
Ajv like any 2020-12 schema; the Type-level `x-policy: { objectPolicy:
"airforce.read-aircraft" }` is the vocabulary annotation that governs read
access to the whole object.

## Relationship

`RelationshipDefinition` (`model/relationship.ts`): `id` (ULID), `name`,
`sourceType`, `targetType`, `cardinality` (`"one-to-one" | "one-to-many" |
"many-to-many"`), `inverseName?`, `edgeSchema?` (a `JsonSchema2020` for
relationship-carried metadata), `resolution: {dataSourceId, operation}`,
`version`, `deprecated?`.

Relationships are first-class registry records, not nested JSON (ADR-0003).
They are authored via a Type's `x-relationships` (or a trait's
`relationships`) and materialized by `toRelationshipDefinition()` in
`registry.ts` at registration time into `TypeDefinition.relationships` and
into the store's own `relationships` index (`store.putRelationship`,
queryable independently via `registry.listRelationships(sourceType)`).
Resolution at runtime: `runtime.getRelationship(typeName, objectId,
relationshipName, identity)` looks up the `RelationshipDefinition`, applies
the property-level (or falling back to object-level) policy, calls
`adapter.resolveRelationship(relDef, objectId)` on the adapter named by
`relDef.resolution.dataSourceId`, then resolves each related object through
`getObject` (silently dropping any the caller isn't authorized to read,
rather than failing the whole navigation).

**Worked example** — `Person.affiliations` / `Organization.members`
(`packages/core/src/base/types/person.ts`,
`packages/core/src/base/types/organization.ts`): a symmetric
many-to-many relationship pair with explicit inverses, proven by
`packages/core/test/relationship-definition.test.ts`. In the airforce
domain, `Aircraft.components` (one-to-many, resolved via
`{dataSourceId: AIRCRAFT_DATA_SOURCE_ID, operation:
"byForeignKey:aircraftId"}`) and `Aircraft.maintenance` (one-to-many,
resolved against the mock-REST data source) are the two relationships that
prove adapter substitution within a single Type.

## Action

`ActionDefinition` (`model/action.ts`): `id`, `name`, `description`,
`applicableTypes: string[]`, `inputSchema`/`outputSchema`
(`JsonSchema2020`), `authorizationPolicy: string`, `preconditions?:
PreconditionSpec[]` (`{description, check: (ctx: ActionContext) =>
Promise<boolean>}`), `implementation: {dataSourceId, operation}`,
`sideEffects: "none" | "creates" | "mutates" | "external"`, `idempotency:
"none" | "key" | "natural"`, `auditRequired: boolean`, `version`,
`deprecated?`.

Actions are first-class governed capabilities, deliberately separate from
the semantic objects they act on (ADR-0005). They are registered
independently of Types (`registry.registerAction()`) and only linked to a
Type by name — a Type's own `x-actions.actions` list is the Type-side
half of that link, while `ActionDefinition.applicableTypes` is the
Action-side half. `runtime.invokeAction(actionName, input, identity)`
enforces, in order: (1) policy — `requireAllowed(identity, "invoke",
action.authorizationPolicy, ...)`, writing an audit event regardless of
outcome; (2) every precondition's `check()`, throwing
`PreconditionFailedError` on the first failure; (3) dispatch to
`adapter.executeAction(action, input, ctx)` on the adapter named by
`action.implementation.dataSourceId`; (4) if `auditRequired`, a second
audit event recording `outcome: "success"`. Actions map 1:1 onto MCP
tools (ADR-0012).

**Worked example** — `CreateMaintenanceWorkOrder`
(`packages/domain-airforce/src/actions/create-maintenance-work-order.ts`):
`applicableTypes: ["airforce.MaintenanceEvent"]`, one precondition ("the
referenced maintenance event must exist", checked by calling the mock-REST
adapter's `resolveProperties`), `authorizationPolicy:
"airforce.maintainer-only"`, `sideEffects: "creates"`, `idempotency:
"none"`, `auditRequired: true`. Its implementation dispatches to
`MockRestAdapter.executeAction`, which calls
`MockRestClient.createWorkOrder({event_id, assigned_to})` and translates
the result back to the canonical `WorkOrder` shape.

## ComputedProperty

`ComputedPropertyDefinition` (`model/type.ts`): `name`, `dependsOn:
string[]`, `resolutionMode: "live" | "materialized" | "cached"`, `compute:
(ctx: ComputeContext) => Promise<unknown>`.

Authored via a Type's `x-computed` (`XComputedSpec = {dependsOn, binding,
resolutionMode?}`), where `binding` names a function supplied in
`RegisterTypeOptions.computedImplementations`. At registration,
`registry.ts`'s `applyComputedSpecs()` looks up the bound implementation and
throws if it's missing, so a computed property can never be registered
without its implementation present. At request time,
`SemanticRuntime.finalizeValues()` runs every `computedProperties` entry for
the object (via a `ComputeContext` exposing `getProperty()`, backed by
already-resolved raw values and prior computed results) and merges the
results into the returned `values`, after which property-level policy
redaction still applies (a computed property is just another property from
the policy engine's point of view). Provenance for a computed property is
not stored directly — `runtime.getProvenance()` detects it's computed and
recursively aggregates the provenance of its `dependsOn` properties instead.

**Worked example** — `Aircraft.readinessStatus`
(`packages/domain-airforce/src/computed/readiness-status.ts`):
`dependsOn: ["maintenanceStatus"]`, `resolutionMode: "live"`, binding
`computeReadinessStatus`, which maps `maintenanceStatus` (`"down" |
"degraded" | "operational"`) to `"NMC" | "PMC" | "FMC"`. A viewer identity
sees `readinessStatus` but not the raw `maintenanceStatus` it depends on
(property-level policy denies `maintenanceStatus` for non-maintainers) —
proven in
`packages/domain-airforce/test/readiness-computed-property.test.ts`.

`ComputeContext` (the `ctx` a binding function receives) also exposes
`getAdapter(dataSourceId)` — not just `getProperty()` — so a computed
property is not limited to its own Type's already-resolved values. A
second worked example, `Aircraft.needsAttention`
(`packages/domain-airforce/src/computed/needs-attention.ts`), combines
`maintenanceStatus` (own source, via `getProperty`) with a live query
against a completely different adapter Aircraft has no `Mapping` to at
all (ADR-0022) — proven in
`packages/domain-airforce/test/needs-attention-computed-property.test.ts`.
This is the pattern to reach for when the combined result is a derived
scalar, not a related object; see
[`how-to/combine-multiple-sources.md`](how-to/combine-multiple-sources.md)
for when to prefer this over a relationship.

## Policy

`Identity` (`model/policy.ts`): `subjectId`, `roles: string[]`,
`attributes: Record<string, unknown>`, `tokenScopes?: string[]` (a seam for
RFC 9396 rich authorization requests, not enforced in v1).

`PolicyRequest`: `{subject: Identity, action: "read" | "invoke",
policyName: string, resource: {typeName, objectId?, propertyPath?,
actionName?}, context?}`. `PolicyDecision`: `{allow: boolean, reason?,
obligations?}`. `PolicyEngine`: the single method `evaluate(request):
Promise<PolicyDecision>`.

Types name policies rather than embedding logic: `x-policy.objectPolicy`
(gate on `getObject`/`query`), `x-policy.propertyPolicies[name]` (per-property
override, else falls back to the object policy), and an
`ActionDefinition.authorizationPolicy`. The actual rule evaluation is
delegated to whatever `PolicyEngine` implementation the Runtime was
constructed with — in this codebase, `AbacPolicyEngine`
(`packages/core/src/policy/abac-policy-engine.ts`), a `Map<policyName,
PolicyRule>` where a `PolicyRule` is `(request) => PolicyDecision |
Promise<PolicyDecision>`. An unregistered policy name denies by default
(fails closed). Two rule helpers are provided: `allowAllRule` and
`requireRole(...roles)`.

**Worked example**: `packages/domain-airforce/src/setup.ts` registers
`"airforce.read-aircraft"` as `requireRole("maintainer", "viewer")` and
`"airforce.maintainer-only"` as `requireRole("maintainer")`. A viewer can
read an Aircraft object but not its `maintenanceStatus` property, and
cannot invoke `CreateMaintenanceWorkOrder`
(`packages/domain-airforce/test/authorization-boundaries.test.ts`).

## DataSource / Mapping

`DataSource` (`model/data-source.ts`): `id`, `name`, `kind: "in-memory" |
"mock-rest" | "postgres" | string`, `config?`. `Mapping`: `id`, `typeName`,
`target: "property" | "relationship" | "action"`, `targetName` (a property
name, relationship name, action name, or the wildcard `"*"`),
`dataSourceId`, `operation`, `resolutionMode: "live" | "materialized" |
"cached"`, `priority?` (still an unused, reserved field — see below for
how multi-source conflicts are actually resolved, which doesn't consult
it).

Together `DataSource` + `Mapping` keep "what something IS" independent from
"where its data comes from." Two resolver methods exist on
`MappingResolver` (`packages/core/src/runtime/mapping-resolver.ts`), for
two different callers:

- `resolvePropertyMapping(typeName, propertyName?)` — the most specific
  property mapping for **one named property** (an exact `targetName`
  match), falling back to the wildcard `"*"` mapping. Used by
  `getProvenance` to resolve one property's source correctly.
- `resolvePropertyMappings(typeName)` — **every** property mapping for a
  Type, split into the required wildcard `base` and zero-or-more
  per-property `overrides`. Used by `getObject`/`query` to merge a Type's
  base bundle with any per-property overrides from other `DataSource`s
  into one object read (ADR-0023) — the real implementation of the
  "multi-source conflict resolution" `priority?` was originally reserved
  for. Two mappings claiming the same `targetName` throw a clear error
  at resolution time rather than silently picking one by priority; see
  ADR-0023's Alternatives Considered for why.

The common case — every adapter in this codebase returns a whole object
per lookup, mirroring a real repository read or REST `GET` — needs only
the wildcard mapping, which is all `airforceMappings`/`hospitalMappings`
register today.

**Worked example**: `airforceMappings`
(`packages/domain-airforce/src/mappings/index.ts`) registers four wildcard
property mappings, e.g. `{typeName: "airforce.Aircraft", target:
"property", targetName: "*", dataSourceId: "in-memory-airforce-repo",
operation: "get", resolutionMode: "live"}`, and
`{typeName: "airforce.MaintenanceEvent", ..., dataSourceId:
"mock-remis-rest", ...}` — the same Type shape, two different sources.

## Event / audit — there is no separate "Event" meta-model concept

The mission brief lists `Event` alongside `Type`, `Property`, `Relationship`,
`Action`, `Policy`, `DataSource`, and `Mapping` as a first-class meta-model
concept. In this codebase there is no `EventDefinition` type and no
event-sourcing or pub/sub mechanism. Two unrelated things satisfy the
brief's intent, and neither should be confused with the other:

1. **`core.Event`** (`packages/core/src/base/types/event.ts`) is an ordinary
   base `Type` — "something that happened at a point in time" (`id`,
   `occurredAt`, `description`) — that a domain Type can `extend`, exactly
   like `core.Asset`. `airforce.MaintenanceEvent` extends it. It is a
   *semantic object*, not a meta-model primitive with its own registration
   API.
2. **`AuditEvent`** (`packages/core/src/audit/audit-log.ts`) is the
   immutable security/audit trail: `{id, timestamp, subjectId, action,
   resource: {typeName, objectId?, propertyPath?}, decision: "allow" |
   "deny", reason?, outcome?: "success" | "failure", details?}`. It is
   written exactly once per policy decision and once per successful
   audit-required Action, always by `SemanticRuntime`, via
   `registry.appendAuditEvent()` (persisted by whichever `RegistryStore` is
   in use). A standalone `AuditSink`/`InMemoryAuditSink` interface also
   exists in the same file as an alternative append/list seam, but the
   Runtime in this codebase writes through the registry's `RegistryStore`,
   not through `AuditSink` directly.

Change propagation, invalidation, and a reactive computed-property DAG (the
"Aircraft.engineHours changed -> FailureRisk stale -> recompute" scenario in
the mission brief) are explicitly out of scope for this pass — `dependsOn`
on a `ComputedPropertyDefinition` is metadata for provenance aggregation
today, not a trigger for recomputation or invalidation.
