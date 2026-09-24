# 0004. Composition via allOf, Not $dynamicRef

## Status

Accepted

## Context

A Type may `extend` a single base Type and mix in zero or more traits
(`Trackable`, `Maintainable`, `Ownable`, `Geolocatable`). JSON Schema
2020-12 offers two broad mechanisms for this kind of composition:

- Plain **`allOf`** with static `$ref`s to already-known schemas.
- **`$dynamicRef`/`$dynamicAnchor`**, which let a base schema reference an
  anchor that a *subclass, not yet known when the base was written*,
  resolves differently — the mechanism 2020-12 introduced specifically for
  open-ended, recursive, polymorphic extension (the canonical example is a
  base "tree node" schema whose `$dynamicRef`-based "extra properties" slot
  is filled in differently by whichever schema currently anchors it).

The mission brief warns against "recreat[ing] the complexity of old
object-oriented inheritance systems," so the choice between these two had to
be made deliberately, not by default.

## Decision

Use **plain `allOf` + static `$ref`s**, exactly as implemented in
`SemanticRegistry.registerType()` (`packages/core/src/registry/registry.ts`):
for a Type with `extends: "core.Asset"` and `traits: [TrackableTrait,
MaintainableTrait]`, the registry builds `allOf: [{$ref: baseSchemaId},
{$ref: traitSchemaId1}, {$ref: traitSchemaId2}, ...ownAllOf, ownSchema]`,
registering each referenced schema with Ajv (`ensureAjvSchema`) before the
composed schema is compiled.

The reasoning: `$dynamicRef`/`$dynamicAnchor` solve the case where a base
schema is written *without knowing in advance* which schemas will extend it,
and needs each extension to plug into a named "slot" at validation time. In
this project's model, the opposite is true — a Type's `extends` and
`traits` are fixed and fully known at the moment `registerType()` is called
("register base types before subtypes" is an enforced precondition, not a
convention). There is no forward-reference: the base type must already be
registered (`store.getType(opts.extends)` throws if it isn't) and every
trait is passed in by value. Composition happens once, at registration
time, and never needs to change based on what extends it later. Plain
`allOf` resolves this fully statically and is compiled once by Ajv per Type
— simpler to implement, simpler to reason about, and immune to a known class
of cross-document `$dynamicAnchor` resolution bugs (the anchor resolving to
the wrong schema when multiple dynamic anchors of the same name are in
scope across a `$ref` chain).

A related gotcha, fixed in the same code path: Ajv's default `strict: true`
mode throws on unrecognized keywords, so the six `x-*` vocabulary keywords
(ADR-0001) must be registered via `ajv.addKeyword(keyword)` (the string-form
call, which registers an annotation-only keyword) *before* any
`SemanticTypeSchema` is compiled — done once in
`createSemanticValidator()` (`packages/core/src/registry/validation.ts`).
Getting this ordering wrong means the very first type registration throws.

## Consequences

- Type composition is single-level and statically resolved: no deep
  inheritance chains, no runtime polymorphism where a base type's shape
  depends on what extends it.
- A trait's own relationships/actions/computed properties are merged into
  the composing Type's flattened `TypeDefinition` at registration time
  (`trait-merge.test.ts` exercises this for `Trackable` + `Maintainable` +
  `Geolocatable` + `Ownable` composed together), so the Runtime never has to
  walk an `allOf` chain at request time to discover what a Type has.
- `$dynamicRef`/`$dynamicAnchor` are reserved as a future extension point
  for a genuinely open-ended polymorphic-extension need (e.g. a plugin
  system where third parties extend a base schema without the base
  knowing about them in advance) — not needed, and deliberately not built,
  for the fixed `extends`/`traits` model this project actually has.

## Alternatives Considered

- **`$dynamicRef`/`$dynamicAnchor` for `extends`/traits**: rejected as
  solving a problem this project doesn't have (open-ended extension of an
  unknown base by an unknown future subclass) at the cost of a materially
  harder-to-reason-about resolution model and a real category of
  cross-document bugs. Revisit only if a future requirement needs a base
  Type to be extensible by third-party schemas it cannot see at
  registration time.
- **Classical multi-level inheritance** (deep `extends` chains): rejected
  per the mission brief's explicit caution against recreating
  object-oriented inheritance complexity; `extends` is capped at one level,
  with traits carrying the reusable, mixable behavior instead.
