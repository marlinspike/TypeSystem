# 0002. Type Identity

## Status

Accepted

## Context

A Type needs an identity that a consumer can reference stably across schema
evolution — the mission brief calls out "think carefully about stable IDs
versus display names" as an explicit requirement. A single "name" field
would conflate at least three different concerns: what a human calls the
Type in a UI, what a program references it by, and which specific version of
its definition is in play.

## Decision

Separate three identifiers, each with a distinct purpose, on `TypeIdentity`
(`packages/core/src/model/type.ts`):

- **`id`** — a registry-assigned ULID (`ulid()`), immutable, assigned once
  per registered version. Never referenced by consumer code; exists as a
  stable internal handle in the registry/store.
- **`name`** — the stable, namespaced **logical name** a consumer actually
  references, e.g. `"airforce.Aircraft"` or `"core.Person"`. This is the
  identity that matters to callers: `registry.getType("airforce.Aircraft")`,
  `runtime.getObject("airforce.Aircraft", ...)`, an MCP resource URI
  (`typesys://types/airforce.Aircraft`), all address a Type by `name`.
- **`version`** — a semver string, resolved independently of `name` (see
  ADR-0010). `registry.getType(name, versionRange?)` can pin to a range;
  omitting it returns the latest version.

`title`/`description` on the `SemanticTypeSchema` are pure display metadata
and can change freely between versions without being a breaking change,
because nothing resolves a Type by `title`.

## Consequences

- Renaming a Type's `title` or `description` is not a breaking change;
  changing its `name` is (there is no rename-in-place for `name` — it would
  require a new type entirely, aliased via `deprecated`/`aliases` at the
  property/relationship level, not the Type-name level).
- Every consumer-facing reference in this codebase (Runtime calls, MCP
  URIs, `applicableTypes` on Actions, relationship `target`s) uses `name`,
  never `id` — `id` is effectively private to the registry/store internals.
- Because `id` is freshly generated on every `registerType()` call (including
  re-registering the same `name`+`version`), it is not useful as a
  cross-version stable identifier — `name` fills that role instead.

## Alternatives Considered

- **Registry-assigned ULID as the primary reference key**: rejected as the
  thing consumers reference. It would make every call site opaque
  (`getObject("01F8...", ...)` instead of `getObject("airforce.Aircraft",
  ...)`), and would require an extra name-to-id lookup at every call site
  for no benefit — the ULID's value is as an internal, collision-free,
  sortable handle, not as a human- or code-facing reference.
- **Semver version folded into the name** (e.g. `"airforce.Aircraft@1.0.0"`
  as the sole identifier): rejected. It would force every caller to either
  hardcode a version or strip it before comparison, and would make "give me
  whatever the latest compatible version is" (the common case, exercised by
  `registry.getType(name)` with no range) awkward to express.
