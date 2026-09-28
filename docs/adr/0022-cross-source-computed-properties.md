# 0022. Cross-Source Computed Properties

## Status

Accepted

## Context

A `ComputeContext` (`packages/core/src/model/context.ts`) has always had
two capabilities: `getProperty(name)` — read an already-resolved value on
this object — and `getAdapter(dataSourceId)` — reach into **any**
registered `Adapter`, not just the one backing this Type's own properties.
That second capability has existed since the computed-property mechanism
was built, but nothing has ever exercised it: the one shipped computed
property, `Aircraft.readinessStatus`, only ever calls `getProperty` against
its own source. There was no real proof that a computed property could
genuinely combine data from two different systems into one derived value —
only that the interface *looked* like it should be able to.

This matters because it's a genuinely different shape of "combine multiple
sources" than relationships (ADR-0006) already prove: a relationship gives
you a related *object* you navigate to explicitly; a cross-source computed
property gives you one *derived scalar* (a boolean, a score, a status)
that's already baked into the object you asked for, with no separate
navigation step. Both are real, both are needed — the question this ADR
answers is which one to reach for, and that only means something once one
of them is actually built and tested.

## Decision

### `Aircraft.needsAttention` — the worked proof

`domain-airforce` already has two real, different adapters
(`InMemoryRepositoryAdapter` for Aircraft/Component, `MockRestAdapter` for
MaintenanceEvent/WorkOrder) — the one place in this repo that can prove
this pattern for real rather than synthetically. `needsAttention`
(`packages/domain-airforce/src/computed/needs-attention.ts`) is `true`
when either is true:

- `maintenanceStatus` (Aircraft's own source) is `"down"` or `"degraded"` —
  resolved via `ctx.getProperty`, exactly like `readinessStatus` already
  does.
- Any non-`"closed"` `WorkOrder` exists against one of this Aircraft's
  `MaintenanceEvent`s — resolved by calling
  `ctx.getAdapter(MAINTENANCE_DATA_SOURCE_ID)` directly and querying both
  Types live. Aircraft has **no** `Mapping` to that data source at all —
  this reaches a system Aircraft's own property resolution never touches.

No new interface was added. `ComputedPropertyDefinition`/`ComputeContext`
are unchanged — a computed property was already "just a function"; this
decision is entirely about proving that function can legitimately span
two adapters, with a real, tested example to point to.

### A circular-import fix this needed, worth naming

Wiring `computeNeedsAttention` into `AircraftType` required
`types/aircraft.ts` to import from `computed/needs-attention.ts`, which in
turn needed `MAINTENANCE_DATA_SOURCE_ID` — previously exported only from
`aircraft.ts` itself. That's a real circular import (`aircraft.ts` →
`needs-attention.ts` → `aircraft.ts`). Fixed by extracting
`AIRCRAFT_DATA_SOURCE_ID`/`MAINTENANCE_DATA_SOURCE_ID` into a new, tiny
`packages/domain-airforce/src/data-source-ids.ts`, re-exported unchanged
from `aircraft.ts` so no existing import anywhere else in the codebase (or
outside it, via `@typesys/domain-airforce`) needed to change.

## Consequences

- **When to prefer this over a relationship**: a derived scalar/boolean
  that isn't itself a navigable object — a status, a count, a flag. If the
  "other data" is itself an object a consumer would want to inspect on its
  own, model it as a relationship (ADR-0006) instead; don't reach for a
  computed property just to avoid registering a `RelationshipDefinition`.
- **Caching is at the computed-property level, not per-source**: setting
  `resolutionMode: "cached"` on the computed property (as `readinessStatus`
  already can) caches the one derived value, not each source call
  separately — sufficient for this pattern, since the whole point is one
  derived value.
- **No policy boundary crossed twice**: the foreign adapter call inside
  `computeNeedsAttention` is *not* re-authorized as a separate read — the
  runtime's normal property-policy check on `needsAttention` itself (as a
  computed property of Aircraft) is the only gate, exactly like
  `readinessStatus`'s dependency on `maintenanceStatus` is gated once, at
  the computed property, not once per dependency.
- **This is not free at scale, and `npm run benchmark` shows it honestly**:
  `runtime.query({ type: "airforce.Aircraft", filter: { property:
  "maintenanceStatus", operator: "eq", value: "operational" } })` measured
  roughly **10x slower** after this ADR (≈1.4ms → ≈15ms p50 for 200 rows in
  the benchmark's synthetic fleet) — every "operational" aircraft in the
  page (the own-source short-circuit only saves the check for "down"/
  "degraded" ones) makes two live cross-adapter `queryByType` calls, and
  that cost multiplies across the whole page, bounded by `maxConcurrency`.
  This is the real, worth-knowing price of pattern 2 at scale — a
  cross-source computed property is not "free" the way an already-resolved
  own-source one is, even with zero simulated network latency, since the
  fan-out itself (bounded concurrency, promise scheduling) has a real
  floor. A Type author choosing this pattern for a high-cardinality query
  path should measure it, the same way this ADR did, not assume it's as
  cheap as `readinessStatus`.

## Alternatives Considered

- **Model `needsAttention` as a relationship instead** (e.g. an
  `openWorkOrders` relationship on Aircraft): rejected — `needsAttention`
  is a boolean signal, not a related object a consumer would ever want to
  page through or navigate further from. Forcing it into relationship
  shape to reuse that mechanism would be the wrong tool for what's
  fundamentally an aggregate/derived value.
- **A declarative "additional data sources" field on
  `ComputedPropertyDefinition`** (listing which other `dataSourceId`s a
  computed property may touch, validated at registration time): rejected
  — `getAdapter` already gives full flexibility, and a declarative list
  would still need arbitrary combination logic in the binding function
  anyway; the declaration would document intent without removing any
  actual code, for a real cost (another field every Type author has to
  learn) that this codebase's existing simplicity bar doesn't justify yet.
- **Fixing the circular import by having `needs-attention.ts` hold its own
  duplicate copy of the data source id string**: rejected — a second
  string literal maintained separately from the one used everywhere else
  is exactly the kind of drift bug that's invisible until the two values
  disagree; extracting a shared, single-source-of-truth module costs one
  small file and removes the duplication risk entirely.
