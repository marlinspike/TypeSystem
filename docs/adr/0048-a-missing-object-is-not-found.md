# 0048. A Missing Object Is Not Found

## Status

Accepted — implemented in `@typesys/core` (`ObjectNotFoundError` in
`runtime/errors.ts`; `authorizeRead` and `readRelationship` in
`runtime/runtime.ts`). Proven by:

- `packages/core/test/object-not-found.test.ts` — `getObject`,
  `getRelationship` (source and targets), an `include`, and `getProvenance`
  on an id nothing holds; the decision-first ordering; and an attack block
  showing that an id-probing caller learns nothing from a missing id that
  a denied one doesn't already tell them.

Mutation-checked (7 mutations): the not-found check moved ahead of the policy
decision, the check removed, a dangling reference swallowed regardless of which
object was missing, every failure swallowed, a dangling reference not dropped,
"empty" judged as one value instead of none, and `ObjectNotFoundError` no
longer a `NotFoundError` — each fails the suite.

## Context

An adapter answers `resolveProperties` for an id it doesn't hold with empty
`values` — the in-memory, mock-REST and PostgreSQL adapters all do — and the
runtime passed that straight through. `getObject("fleet.Vehicle", "nope")`
returned `{ typeName, objectId, values: {} }`, which is also what an object
with no readable properties looks like. A consumer had to test
`Object.keys(values).length === 0` to find out, and every consumer had to
know to. A relationship to a record that no longer exists produced a hollow
object in the list, and `getProvenance` of a missing object returned `[]`.
`NotFoundError` meant only an unknown Type, relationship, Action or data
source.

The object policy is decided on an object's stored attributes before
anything else about the object (ADR-0030). For an id nothing holds, those
attributes are the empty set. That ordering is what makes a fix safe or
unsafe: raising "not found" *before* the decision would tell a caller the
policy denies whether an id exists.

## Decision

**1. Missing means no source holds a value for it.** The object's base
mapping, merged with its per-property overrides (ADR-0023), resolves zero
stored values. That is what every shipped adapter already returns for an
unknown id, and what the runtime already held in hand: no new adapter
method, no second round trip. An object that only an override source holds
is not missing.

**2. `ObjectNotFoundError`, a subclass of `NotFoundError`.** It carries the
Type name and object id the caller supplied (and no stored value). A caller
that maps `NotFoundError` to a 404 needs no change. `getObject` raises it;
`getRelationship` and `getProvenance` raise it for their source object.

**3. After the decision, never before.** `authorizeRead` checks the object's
classification (before any read, ADR-0032), reads the stored values, decides
the object policy on them (ADR-0030), and only then looks at whether there
were any. A caller the policy denies on an empty record gets
`AuthorizationError`, exactly as for an existing record they may not read. So:

- a rule that needs an attribute (`requireAttributeMatch`, a Cedar condition
  on the resource) denies a missing id like any row it doesn't match: a 403
  for missing and forbidden alike, and a prober learns nothing;
- a role-only rule gives every caller the same answer for every id of the
  Type, so the only callers who see `ObjectNotFoundError` are ones allowed
  to read the whole Type.

**4. Nothing runs after it.** A missing object is never finalized: no
computed property is computed, no property policy evaluated.

**5. A dangling reference is omitted, not fatal.** When a relationship
resolves to an id nothing holds, `getRelationship` and an `include` leave it
out of the result, as they leave out a related object the caller may not
read (ADR-0030). Only the failure for *that* reference — the same Type and
id — is swallowed; any other error, including one raised while reading a
related object for another reason, still propagates.

**6. `query` is unchanged.** Its items come from the store's own listing.

## Consequences

- A consumer no longer tests for empty `values`. The web example in
  `docs/how-to/start-a-project.md` drops its check, and an MCP
  `resources/read` of a missing object is an error response rather than an
  empty object.
- **Breaking for a caller that relied on the empty object.** Nothing is
  published; the changeset is a minor bump of `@typesys/core`.
- Audit: a read of a missing id writes the object-policy row the decision
  produced (allow, for a caller the rule admits) and no row for the
  not-found, which is the span's error. An operator will see an allow for an
  id that held nothing.
- A missing source in `getRelationship` or `getProvenance` is now an error
  where it was an empty list.
- A dangling reference vanishes from a relationship. The runtime does not
  surface referential-integrity problems in the source system.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **A rule that admits an empty record makes missing distinguishable from
  denied.** A deny-list rule ("anyone but X", a Cedar `forbid` with no
  matching attribute) allows an object with no attributes, so a caller it
  denies on real rows gets `ObjectNotFoundError` for an id that isn't there
  and `AuthorizationError` for one that is. The empty object was the same
  oracle before this change; rules that need an attribute to allow, as every
  shipped row-level combinator does, are not affected.
- **Negative results are cached.** With `resolutionMode: "cached"`, the
  adapter's empty answer for a missing id is cached for the TTL, so an
  object created just after a miss reads as not found until the entry
  expires or `invalidateObject` runs. The empty object was cached the same
  way.
- **"Empty" is the adapter's signal.** An adapter whose rows can exist with
  no mapped values would report them missing. Every shipped adapter returns
  at least the record's own fields.

## Alternatives Considered

- **Raise `AuthorizationError` for a missing id too.** Closes the deny-list
  oracle outright, but then a typo and a forbidden id read the same to a
  caller who is allowed to read everything, and the request was for
  `NotFoundError`.
- **Raise `NotFoundError` before the policy decision.** Simpler, and an
  existence oracle for every caller the policy denies.
- **An optional `Adapter.exists(typeName, id)`.** A second source of truth
  beside the values the runtime already reads, an extra round trip, and a
  capability every adapter would have to implement or be silently treated as
  "everything exists".
- **Keep the empty object and add an `exists` flag to `ResolvedObject`.**
  Moves the check into every consumer, which is the defect.
- **Fail the whole relationship on a dangling reference.** One stale index
  entry in a source system would make every read of that relationship throw.
