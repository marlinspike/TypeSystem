# 0028. Relationship Resolution Beyond Foreign Keys

## Status

Proposed — written ahead of implementation (an ADR-first workflow), unlike
the accepted ADRs that describe code already in the tree. It flips to
Accepted, with the concrete "proven, not assumed" evidence (test names,
measured numbers) filled in, when the implementation lands.

## Context

A `RelationshipDefinition.resolution` is `{ dataSourceId: string; operation:
string }` (`packages/core/src/model/relationship.ts`), and the operation
string is one of exactly two conventions each adapter parses for itself:
`byForeignKey:<field>` (target rows whose `<field>` equals the source id) and
`byOwnField:<field>` (target ids read from a field on the source object).
`Aircraft.components` and `Aircraft.maintenance` both use
`byForeignKey:aircraftId` (`packages/domain-airforce/src/types/aircraft.ts`).
`completeness.md` states the limit plainly: "one convention, not a general
join mechanism."

Three real needs fall outside it:

- **Many-to-many.** An Aircraft assigned to many crew, each crew member on
  many aircraft, is a join/association table. Today it can only be modelled
  by inventing an explicit association Type with two one-to-many
  relationships — workable, but it leaks a storage artefact into the semantic
  model and forces consumers to hop through it.
- **Composite and cross-source keys.** A relationship keyed on more than one
  field, or whose association rows live in a *third* `DataSource` (neither
  the source's nor the target's), can't be said in the string grammar.
- **Bounded, filtered, ordered traversal.** `resolveRelationship` returns
  *all* related refs (`adapter.ts`). A one-to-many with thousands of targets
  is an unbounded fan-out — the runtime bounds the *concurrency* of resolving
  them (ADR-0019) but never the *count*. There is no way to say "this
  aircraft's ten most recent maintenance events."

This must stay inside ADR-0003's deliberate stance — relationships are
first-class records, property-graph-flavoured, *not* a general graph database
— so the answer is a small closed set of strategies, not an open traversal
language.

## Decision

**1. A parsed, closed `ResolutionStrategy`, with the string kept as the
authoring surface.** The terse `operation` string stays (it is
YAML/agent-friendly and already in every domain), but core gains one shared
`parseResolution(operation)` that turns it into a typed, discriminated
`ResolutionStrategy`, exactly as `matchesFilter` (ADR-0011) is the one shared
filter interpreter every adapter reuses instead of re-parsing. Adapters
consume the parsed strategy; none re-implements string-splitting. The closed
set:

- `byForeignKey:<field>` — unchanged.
- `byOwnField:<field>` — unchanged.
- `byJoinTable:<dataSourceId>?/<table>/<sourceKey>/<targetKey>` — new:
  many-to-many through an association, whose rows may live in a different
  `DataSource` than either endpoint.
- `byCompositeKey:<field>=<sourceField>[,<field>=<sourceField>...]` — new:
  more than one key field.

An adapter implements the strategies it can and throws
`UnsupportedResolutionError` (naming the strategy and `dataSourceId`) for the
rest — the same "clear typed error, never wrong data" contract ADR-0027 uses
for aggregation.

**2. Join-table and cross-source resolution is a batched two-step, not
N+1.** For `byJoinTable`, the runtime reads association rows from the join
`DataSource`'s adapter once, then batch-fetches the targets from the target
type's adapter — reusing the bounded-concurrency fan-out already in
`getRelationship` (`mapWithConcurrencySettled`, ADR-0019) rather than one
round trip per association row. Cross-source relationships already work for
the simple case (ADR-0006 resolves `Aircraft.maintenance` through a different
adapter); this generalises that to the association case.

**3. Relationship traversal becomes bounded and shapeable.**
`Adapter.resolveRelationship(relationship, sourceObjectId, opts?)` gains an
optional `opts` carrying `{ filter?, sort?, limit?, cursor?, signal? }`
(`filter`/`sort` reusing ADR-0027's shapes, `signal` reusing ADR-0026). A new
`QueryLimits.maxRelatedPerObject` gives relationship resolution a default
ceiling the way `defaultLimit` does for top-level queries, so an unbounded
one-to-many stops being an unbounded fan-out. `include` in the query DSL
grows the matching optional `limit`/`sort` so nested traversal is bounded per
level too.

**4. Backward compatibility is total.** The two existing strategies parse
unchanged; `opts` is optional and omitting it preserves "resolve all,
unordered" (subject to the new default ceiling, which is a safety bound, not
a behaviour change any current domain will notice at its data sizes). No
existing `RelationshipDefinition` or adapter needs editing to keep working.

## Consequences

- Many-to-many, composite-key, and third-source-association relationships
  become first-class, without a graph query language and without leaking a
  join table into the semantic model as a fake Type.
- The latent unbounded-fan-out on large one-to-many relationships is closed
  by a default `maxRelatedPerObject`, complementing ADR-0019's concurrency
  bound with a count bound.
- Relationship parsing lives in one shared place, so a new adapter gets
  correct strategy semantics for free (or a clear unsupported error), the
  same property `matchesFilter` gives filtering.
- Adapters gain an optional `opts` parameter and opt into the new strategies;
  the in-memory and Postgres adapters implement `byJoinTable`, the mock-REST
  adapter declines it with a typed error.
- Edge metadata on an association (the existing `RelationshipDefinition.
  edgeSchema`) has a natural home in `byJoinTable`, resolvable later without
  another model change.

## Alternatives Considered

- **A real graph query layer (Cypher/Gremlin-style traversal).** Rejected:
  squarely against ADR-0003's "not a graph database" decision, and a large
  new surface to design, secure, and bound. A closed strategy set covers the
  concrete needs (M:N, composite, cross-source, bounded) without it.
- **Keep foreign-key-only and require modelling M:N as an explicit
  association Type.** This works today and stays valid — but it forces a
  storage artefact into the semantic model, makes consumers hop through a
  synthetic object, and gives the runtime no way to batch the association
  read or bound the traversal. First-class `byJoinTable` removes those costs
  while leaving the association-as-Type pattern available for associations
  that genuinely carry rich, independently-meaningful data.
- **Arbitrary SQL joins expressed in the mapping.** Rejected: it leaks the
  backend's dialect into the model, is an injection surface, and cannot span
  two different adapters — precisely the coupling ADR-0006 exists to prevent.
- **A structured object instead of the `operation` string.** Considered;
  deferred. Replacing the string outright would touch every existing domain
  and the YAML authoring path. Parsing the string into a typed strategy gets
  the type-safety internally while keeping the terse authoring surface, and a
  future ADR can promote the parsed form to the authored form if the string
  grammar ever gets crowded.
