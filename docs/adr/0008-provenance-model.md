# 0008. Provenance Model

## Status

Accepted

## Context

Federal and DoD consumers in particular need to know where a resolved value
came from, how fresh it is, and how confident the system is in it. The
mission brief is explicit that this must not mean physically attaching a
full provenance record to every property of every returned object by
default — that would bloat every response for consumers who don't need it —
while still treating provenance as "a first-class architectural capability."

## Decision

Model provenance as `ProvenanceRef`
(`packages/core/src/model/provenance.ts`): `propertyPath`, `source:
{dataSourceId, system, recordId?, field?}`, `observedAt?`, `retrievedAt`,
`confidence?`, `classification?`. Every `Adapter.resolveProperties()` and
`Adapter.queryByType()` call returns provenance alongside values
unconditionally (`ResolvedProperties`/`AdapterQueryResult` both carry a
`provenance: ProvenanceRef[]` field) — the adapter always knows where its
own data came from, at negligible cost, since it's already resolving that
one adapter's records.

What's *not* unconditional is exposing that provenance to the caller.
`SemanticRuntime.getObject()`/`query()` only include `provenance` in the
returned `ResolvedObject` when the caller opts in
(`opts.includeProvenance` / `SemanticQuery.includeProvenance`). Otherwise
the fetched provenance is discarded after being used to filter which
properties survived policy redaction (`finalizeValues()` narrows
`resolved.provenance` down to properties still present in `values`). A
caller who wants provenance for one specific property without fetching the
whole object calls `runtime.getProvenance(typeName, objectId, propertyPath,
identity)` directly, which is itself policy-gated (same
`propertyPolicies`/`objectPolicy` fallback as any other property read).

For a **computed property**, there is no adapter-produced provenance record
at all — `getProvenance()` detects the property is computed
(`typeDef.computedProperties.find(...)`) and instead recurses into its
`dependsOn` list, aggregating (flattening) the provenance of each dependency.
`Aircraft.readinessStatus`'s provenance is exactly the provenance of
`maintenanceStatus`, its one dependency
(`packages/domain-airforce/test/readiness-computed-property.test.ts`).

## Consequences

- Ordinary object/query responses stay lean by default; provenance is
  there when asked for, at either the whole-object or single-property
  granularity.
- Provenance for a derived value is defined in terms of its inputs'
  provenance rather than invented at the point of computation — there is no
  notion of "provenance of the computation itself" (e.g. which formula
  version ran), only provenance of the data the computation consumed.
- `classification` and `confidence` exist on `ProvenanceRef` and are
  populated by adapters today with simple constants (`confidence: 1` for
  the in-memory adapter, `confidence: 0.9` for the mock-REST adapter, no
  `classification` set by either) — real classification/handling metadata
  and confidence scoring from an actual source system is left to whatever
  adapter is built for that system.
- Multi-source conflict resolution (an object assembled from several
  sources, each claiming authority over different properties) is
  represented structurally by `Mapping.priority?` but not exercised or
  enforced by the Runtime in this pass — see the mission brief's "multiple
  sources of truth" requirement as a documented, not built, extension.

## Alternatives Considered

- **Attach full `ProvenanceRef[]` to every property on every response by
  default**: rejected as the mission brief explicitly cautions against —
  it would double or triple the size of every ordinary read for the common
  case where provenance isn't needed.
- **A separate provenance service/store, decoupled from the Adapter**:
  rejected as premature — the adapter that resolves a value is exactly the
  system that knows that value's provenance; introducing an intermediary
  store would only be justified once provenance needs to survive longer
  than a single resolution (e.g. audit-grade provenance history), which is
  not a requirement this pass needs to satisfy.
