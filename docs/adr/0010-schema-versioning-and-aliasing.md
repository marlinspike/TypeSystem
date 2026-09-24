# 0010. Schema Versioning and Aliasing

## Status

Accepted

## Context

Enterprise semantic models evolve for years; existing consumers must not
silently break when a Type or property is renamed, deprecated, or given a
new version. The mission brief calls for explicit support for versioning,
backward compatibility, deprecation, aliases, and schema evolution — and to
think carefully about stable IDs versus display names (addressed separately
in ADR-0002).

## Decision

Version every `TypeDefinition` and `ActionDefinition` with a **semver**
string (the `semver` npm package, `7.8.5`), retaining **all** previously
registered versions rather than overwriting them. `InMemoryRegistryStore`
(`packages/core/src/registry/in-memory-registry-store.ts`) stores each
Type/Action as an array of versions keyed by name; `putType`/`putAction`
replace only the entry with the exact same version, leaving every other
version untouched. `registry.getType(name, versionRange?)` (and the
equivalent for Actions) returns the latest version when no range is given
(`semver.rcompare`-sorted), or the highest version satisfying an explicit
range (`semver.satisfies`) when one is given —
`packages/core/test/registry-versioning-and-aliasing.test.ts` proves both a
plain "give me latest" call and a pinned `"^1.0.0"` range call resolve
correctly with two registered versions of the same Type.

Two additional fields on `TypeDefinition`/`ActionDefinition` (and
`RelationshipDefinition`) support graceful evolution without breaking
existing consumers:

- **`deprecated?: {since, supersededBy?, sunsetAt?}`** — marks a
  version/definition as deprecated without removing it; existing consumers
  pinned to it keep working until `sunsetAt`, if ever enforced.
- **`aliases?: Record<oldName, newName>`** on `TypeDefinition` — lets a
  consumer keep referencing an old property/relationship name after a
  rename. `registry.resolveAlias(typeDef, name)` resolves an alias to its
  current name (or returns the name unchanged if it isn't an alias); the
  Runtime calls this in `getRelationship()` before looking up the
  relationship by name, so an old relationship name a consumer hasn't
  migrated off of still resolves.

Both are exercised by a real test, not merely declared as unused fields:
`registry-versioning-and-aliasing.test.ts`'s second case registers
`test.Renamed` v1 with a `legacyStatus` property, then v2 with `status` plus
`aliases: {legacyStatus: "status"}` and `deprecated: {since: "2.0.0"}`, and
asserts `resolveAlias(def, "legacyStatus") === "status"` while the v1
definition (with `legacyStatus` still present) remains independently
retrievable via `getType("test.Renamed", "1.0.0")`.

## Consequences

- No Type/Action registration is ever destructive to a previous version —
  a consumer pinned to `"^1.0.0"` keeps resolving to a 1.x version even
  after 2.0.0 is registered.
- Aliasing is currently wired into relationship-name resolution in the
  Runtime; it is not yet wired into ordinary object property lookups
  (`getObject`/`query` do not consult `aliases` when reading `values`) —
  the alias mechanism as built and tested covers relationship renames, and
  extending it to plain property renames would follow the same
  `resolveAlias` pattern.
- `InMemoryRegistryStore` retains every version forever (no garbage
  collection of old versions) — acceptable for an in-memory store backing
  tests and a demo; a durable store (ADR-0014) would need an explicit
  retention/archival policy for old versions in a real deployment.

## Alternatives Considered

- **Overwrite-in-place versioning** (only the latest version of a Type is
  ever stored): rejected outright — it directly violates the mission
  brief's "existing consumers must not silently break" requirement, since
  any consumer pinned to an older shape would simply lose access to it.
- **A separate migration-script mechanism** (explicit imperative migration
  code run when a consumer requests an old version): rejected as
  unnecessary complexity for this pass — retaining every version verbatim
  and resolving by semver range already satisfies the compatibility
  requirement without needing to define what a "migration" would even mean
  for a structural schema change; if a future requirement needs
  computed/derived compatibility shims between versions, that can be added
  as a distinct capability without changing how versions are stored.
