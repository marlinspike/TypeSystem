# 0007. Runtime Resolution Modes

## Status

Accepted

## Context

The mission brief requires the semantic definition to remain independent of
the physical resolution strategy — some properties resolved live from a
source API, others ingested into a canonical store, others projected from
events — without hardcoding a single strategy into the Type itself.

## Decision

Type `ResolutionMode` as a fixed union, `"live" | "materialized" |
"cached"`, used on both `Mapping.resolutionMode`
(`packages/core/src/model/data-source.ts`) and
`ComputedPropertyDefinition.resolutionMode`
(`packages/core/src/model/type.ts`). Only two of the three are actually
exercised in this codebase:

- **`live`** — the adapter is called at request time. Every `Mapping` in
  `packages/domain-airforce/src/mappings/index.ts` uses `"live"`, and
  `Aircraft.readinessStatus`'s `x-computed` spec also declares `"live"`
  (`packages/domain-airforce/src/types/aircraft.ts`), since it has exactly
  one dependency and no expensive fan-out.
- **`materialized`** — supported generically by the model (a `Mapping`
  could point at a pre-computed projection instead of a live adapter call,
  with zero change to `SemanticRuntime` or the `Adapter` interface, since
  the Runtime only ever reads `mapping.dataSourceId`/`operation` and calls
  the same `Adapter` methods either way), but no `Mapping` in this codebase
  actually uses it — there is no ingest/materialization pipeline built.
- **`cached`** — named in the type union and documented as a future
  resolution mode, but not implemented: there is no cache layer, cache
  invalidation policy, or TTL mechanism anywhere in this codebase. Setting
  `resolutionMode: "cached"` on a `Mapping` today would compile but produce
  no different runtime behavior from `"live"`, since `SemanticRuntime` does
  not branch on `resolutionMode` at all — the mode is currently metadata,
  not (yet) an instruction the Runtime dispatches on.

## Consequences

- The Type definition never encodes *how* a property is resolved — only
  the `Mapping` does, and only as declarative metadata (`dataSourceId`,
  `operation`, `resolutionMode`) that a future runtime enhancement could
  branch on without touching any Type schema.
- Introducing a real cache layer later is additive: it would consume the
  existing `resolutionMode` field rather than requiring a new one, and
  would sit between `SemanticRuntime` and `Adapter` without changing either
  interface.
- Because `resolutionMode` is not yet enforced, declaring `"cached"` today
  is honest-but-inert — documentation of intent, not a working feature. Do
  not describe `"cached"` as implemented in any consumer-facing material.

## Alternatives Considered

- **Building a real caching layer now** (TTL-based or event-invalidated):
  rejected as premature for this pass — the mission brief explicitly warns
  against building "a gigantic reactive DAG engine" or speculative
  abstraction in the first iteration, and nothing in the vertical slice's
  data volumes or latency requirements demands one. The seam (`Mapping`
  carrying a `resolutionMode`) is cheap to add now and expensive to retrofit
  later, so it was added; the implementation behind it was not.
- **Encoding resolution strategy on the Type itself rather than the
  Mapping**: rejected — it would re-couple "what something IS" to "how it's
  physically resolved," which is exactly the separation ADR-0006 exists to
  preserve.
