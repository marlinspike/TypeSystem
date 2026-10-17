# 0095. A Read Returns Only What the Model Declares

## Status

Accepted (2026-10-17). Found by the Milestone D evaluation
(`scripts/measure-workbench.ts`, change X5). Amends ADR-0006 (wildcard
mappings) and builds on ADR-0032 (classification) and ADR-0052
(derivation). Implemented in `packages/core/src/runtime/runtime.ts`
(`finalizeValues`, `requireReadableProperties`). Proven by
`packages/core/test/declared-values.test.ts`.

## Context

A wildcard property mapping (`targetName: "*"`) hands the runtime the
whole record a source returns. The runtime then applied every member
policy, marking and derivation rule the model declares, and returned
everything else as it came.

So a value the model does not declare reached every reader of the
object, governed only by the object policy. The evaluation removed
`model` from `airforce.Aircraft` and read the aircraft as the viewer:
`model` was still returned. The same happens when a source adds a
column. The hospital's sample patients carried a `name` the model never
declared (the model's name is `displayName`, from `core.Party`), so
every patient's name was returned outside the contract, and a query
could filter and sort on it.

A filter on such a column was worse than the read. The query validator
decided policies and markings on declared names only, so a caller could
ask for patients whose undeclared `ssn` equals a guess and learn the
answer from whether a row came back.

## Decision

**A read returns only the stored values the model declares** for the
Type, its base Types and its traits, as `describeModel` composes them,
plus its computed values. Anything else a source returns is dropped
before classification, policies and derivations run, and its provenance
is dropped with it.

**A query, aggregate or search that names an undeclared value is
refused** as invalid input, naming the value. A computed value may still
be filtered on (ADR-0054).

The declared names are composed once per Type definition object, so a
read pays no extra registry lookups after the first.

## Consequences

- A column added to a source is invisible until a modeler declares it,
  and declaring it is where its policy and marking are decided.
- Removing a value from the model removes it from every read, which is
  what the contract diff already said it did.
- The hospital's sample data now uses `displayName`, which the model
  declares and requires. Tests that filtered on `name` were filtering on
  an ungoverned column and now use `displayName`.
- A deployment that relied on undeclared values passing through must
  declare them. That is intended: until it does, nobody has decided who
  may read them.
- If a base Type is registered again with different properties, a
  subtype registered earlier keeps the composition it had until it is
  registered again too.

## Amendment (5.0 pressure test, 2026-10-17)

A computed value whose `dependsOn` named an undeclared value was
registered, and after this ADR silently computed from nothing. The
registry now refuses a computed value that depends on anything other
than a value its Type declares or another computed value.
