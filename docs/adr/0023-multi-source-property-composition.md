# 0023. Multi-Source Property Composition

## Status

Accepted

## Context

ADR-0006 introduced the `Mapping` model with field-level granularity built
in — `{typeName, target: "property", targetName, dataSourceId, operation}`
— and said outright, at the time: "the model supports a more granular
per-property `Mapping` (specific `targetName`), but nothing in this
codebase currently needs it." Every domain built since (`domain-airforce`,
`domain-hospital`) has used exactly one wildcard (`targetName: "*"`)
mapping per Type, because every one of their Types happens to have all its
own properties served by a single system.

That's not always true for a real object. An `Aircraft`'s core record
lives in one repository, but its warranty status might live in a
completely separate warranty-tracking system, keyed by the same aircraft
id. Today, a consumer asking for that Aircraft has no way to see both —
`getObject`/`query` only ever resolve the wildcard mapping and fetch the
whole object from one adapter. `MappingResolver.resolvePropertyMapping`
already picks a specific per-property `Mapping` over the wildcard when
asked for one *named* property (which is exactly why `getProvenance` for
a single named property already honors an override mapping correctly) —
the gap is narrower than it first looks: `getObject`/`query` simply never
ask for *every* property mapping and merge the results.

## Decision

### `MappingResolver.resolvePropertyMappings(typeName)`

Returns `{ base: Mapping; overrides: Mapping[] }` — the required wildcard
mapping plus every specific per-property mapping registered for that Type.
Throws if there's no wildcard mapping (same failure the singular
`resolvePropertyMapping` already had), and throws if two mappings claim the
same `targetName` — a genuine misconfiguration gets a clear error instead
of the resolver silently picking one, matching this codebase's existing
fail-closed conventions (an unknown policy name denies, a failed auth
verification falls back to anonymous — nothing here ever guesses quietly).

### `SemanticRuntime` merges base + overrides, concurrently and bounded

`resolveObjectProperties(typeName, objectId)` (used by `getObject`) and the
per-item path inside `query()` both: resolve the base bundle from its
adapter exactly as before, then — only if any per-property overrides
exist — fan out to each override's adapter (`mapWithConcurrency`, bounded
by the same `maxConcurrency` every other fan-out in this runtime already
respects, ADR-0019) and merge each override's value (and provenance) over
the base's for that one field. An override system with nothing for this
object leaves the base's value (or its absence) untouched — no error, no
special-casing by the caller.

Provenance is exactly as correct here as everywhere else in this codebase:
`warrantyStatus`'s provenance names the warranty system, not the base
repository, even though both values arrived in the same `getObject` call —
because the override's fetched `ResolvedProperties` (values *and*
provenance together) replaces the base's entry for that one field, not
just the value.

### Zero cost for every Type that doesn't use this

`mergeOverrides` returns the base bundle completely unchanged, with zero
adapter calls, whenever `overrides.length === 0` — which is every Type in
`domain-airforce` and `domain-hospital` today. This is proven by a test
that asserts an override adapter's call counter never leaves zero for a
Type with only a wildcard mapping, not just claimed in prose.

### `query()`'s base listing stays single-source; only the merge fans out

Filtering, pagination, and cursoring are answered by exactly one adapter
call, same as before — there is no such thing as "list objects matching
this filter" split across two systems in this model. Only the per-item
property merge (after the base list comes back) fans out to override
systems, one merge per item on the page, same bounded concurrency as the
base list's own item-level work already uses.

### A real bug fix this decision surfaces: `invalidateObject`

`invalidateObject` used to find the *first* property mapping for a Type
and clear only its cache entry — harmless when there was always exactly
one. With overrides now possible, it iterates every property mapping (base
and every override) and clears each one's cache key independently, so
invalidating an object actually clears every system's cached view of it,
not just the base's.

## Consequences

- Opt-in per field, exactly like caching (ADR-0016) and rate limiting
  (ADR-0019) are opt-in per mapping/identity: a Type author registers a
  specific `Mapping` for exactly the field(s) that live somewhere else,
  and nothing else about that Type's authoring changes.
- Composing N sources into one object costs N adapter calls (bounded,
  concurrent) instead of 1 — an explicit, visible tradeoff a Type author
  makes deliberately, the same way choosing `"cached"` is a deliberate
  tradeoff of staleness for speed.
- `getProvenance` for a named override property was already correct
  before this ADR; this decision is entirely about `getObject`/`query`'s
  bulk paths catching up to what single-property resolution already did.

## Alternatives Considered

- **Always resolve every property mapping, even when there's only a
  wildcard**: rejected — that would mean every existing domain pays an
  extra `listMappings` filter-and-check cost on every single read for a
  capability it never uses. The chosen design still calls
  `resolvePropertyMappings` once (cheap, no adapter I/O) but only ever
  fans out to adapters when `overrides.length > 0`.
- **Silently preferring one of two conflicting override mappings for the
  same field** (e.g. whichever was registered last): rejected — a Type
  author who accidentally double-mapped a field deserves a loud, specific
  error at read time, not a mysteriously "wrong" value depending on
  registration order.
- **Teaching `queryByType` itself to accept multiple DataSources and merge
  internally**: rejected — that pushes cross-source merge logic into every
  `Adapter` implementation, the exact "adapter has to know about other
  adapters" coupling ADR-0006 already rejected once. Keeping the merge in
  `SemanticRuntime`, one layer up, is the same reasoning ADR-0006 used for
  why adapters don't branch on each other at all.
