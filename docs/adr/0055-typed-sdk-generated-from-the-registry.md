# 0055. A Typed SDK, Generated from the Registry

## Status

Accepted — implemented in the new `@typesys/sdk` (`model.ts`, `expr.ts`,
`query.ts`, `client.ts`, `transport.ts`, `codegen.ts`, `schema-ts.ts`),
`@typesys/core` (`XComputedSpec.schema`, `ComputedPropertyDefinition.schema`,
checked at registration and on every computation; `ComputedValueError`;
`ActionSummary`/`summarizeAction`), `@typesys/registry-store-postgres` (the
schema persisted with the computed property), `@typesys/cli`
(`typesys generate-sdk`, and `generate-types` now using the SDK's schema
conversion), and the two demo domains, which commit their generated models
(`AirforceModel`, `HospitalModel`). Proven by:

- `packages/sdk/test/types.test.ts`: checked by `npm run typecheck`. Row
  types for stored and computed values, selections, nested includes and
  provenance; Action inputs, outputs and listed names; and twelve mistakes
  refused at compile time, each an `@ts-expect-error` that fails the
  typecheck if it ever compiles (an unknown Type, property, relationship or
  Action; a top-level sort on a computed property; a value outside an enum,
  in a filter or an Action input; an operator the runtime does not apply to
  that value's type; an equality shorthand of the wrong type; a filter built
  for one Type used on another; a Type from another model).
- `packages/sdk/test/client.test.ts`: six queries written with the SDK,
  for the maintainer, the viewer and an anonymous caller, return exactly
  what `runtime.query` returns for the `SemanticQuery` each builds, in
  process and over MCP, refusals included; reads, relationships,
  provenance, explain, paging, and typed Actions (list, preview, invoke)
  agree across both transports; the viewer's filter on the withheld
  `readinessStatus` matches nothing (ADR-0052).
- `packages/sdk/test/codegen.test.ts`: the committed domain models match
  what their registries generate; a generated model compiles under
  `--strict`; a computed value outside its declared schema fails the read
  with `ComputedValueError`; an invalid value schema fails registration.
- `packages/cli/test/generate-sdk.test.ts`: `typesys generate-sdk` writes
  a model from YAML and `--check` fails once it drifts.

Mutation-checked: six runtime mutations (MCP provenance not dropped,
conjunctions nested rather than flattened, `all()` stopping after one page,
included objects left unconverted, the computed value check removed, the
registration check removed) and one type mutation (ordering operators
offered on strings) each fail at least one test.

## Context

Every name a developer wrote against TypeSys was a string and every value was
`unknown` (see `docs/evidence/baseline-2026-10-13.md`). `typesys
generate-types` emitted interfaces, but nothing connected them to query
results, includes, projections or Actions, and a computed property's value
type was not declared anywhere.

The roadmap first proposed inferring types from the literal schemas a
domain is written with. That does not hold up: domains declare their Types
as `DomainTypeEntry`, which widens every literal; `extends` and traits are
composed by the registry at registration (ADR-0004); YAML and
Postgres-stored registries have no TypeScript source at all. The registry
is the one place the composed model exists.

## Decision

**Generate a model from the registry.** `generateModel(describeModel(registry))` emits one
self-contained interface: each Type's flattened stored properties, its
computed properties typed by their declared value schemas, its
relationships with their targets and cardinality, the Actions that apply
to it, and each Action's input, output and target. The file imports
nothing, so a domain commits it beside its Types and checks for drift by
generating again (`npm run sdk:models -- --check`, `typesys generate-sdk
--check`). There is no second schema to maintain; the model is a view of
the registry.

**Declare computed value types, and enforce them.** `x-computed.<name>`
gains an optional `schema`. The registry compiles it at registration; the
runtime checks every computed value against it and fails the read with
`ComputedValueError` on a mismatch, a defect in the domain's binding. The
type a client is told is the type it receives. Without a schema the value
is `unknown`.

**Every row value is optional.** Policy, classification and derivation may
withhold any value from any caller (ADR-0030, ADR-0032, ADR-0052), so a row
type that promised a required value would be wrong the first time one was
withheld. Rows carry `$id` and `$type` beside their values; included
relationships are arrays, as the runtime returns them.

**The builder compiles to the query DSL and nothing else.** `Query` is
immutable; `toQuery()` is the `SemanticQuery` it stands for, which is all a
transport sends. The SDK therefore adds no semantics and enforces nothing:
the runtime validates, plans, authorizes and audits the query as if it were
written by hand. The types narrow only what the runtime would refuse or
silently mismatch: a top-level `orderBy` accepts stored properties only (the
source sorts, ADR-0054), an include's accepts computed ones too (ADR-0028);
ordering operators exist on numbers, `icontains` on strings and `contains`
on arrays, matching the shared filter interpreter; a filter is branded with
its Type.

**One client, two transports.** `runtimeTransport(runtime, identity)` calls
a runtime in process; `mcpTransport(client, { authToken })` calls a TypeSys
MCP server's tools and needs only a `callTool` method, so the SDK has no MCP
dependency. Both return the runtime's wire shapes; the client converts.
MCP carries only an error's message, so remote refusals are
`RemoteToolError`, while in-process ones keep the runtime's error classes.

The SDK imports only types from `@typesys/core` (the in-process transport
loads one function from it on use), so it can run in a browser against a
remote transport, which slice 7's HTTP API and React bindings rely on.

## Consequences

- An application or agent harness writes `client.from("airforce.Aircraft")
  .where((a) => a.needsAttention.eq(true)).include("components")` and gets
  typed rows, with the runtime still deciding every value per caller.
- A computed property without a `schema` types as `unknown`. Domains should
  declare one; the two demo domains do where they have computed properties.
- `generate-types` remains for plain interfaces; `generate-sdk` is what a
  client uses. Both share one JSON Schema to TypeScript converter, which
  widens anything it cannot express exactly (a `$ref`) to `unknown` rather
  than claim a type nothing enforces.
- Not in this slice: aggregates through the builder (use
  `runtime.aggregate` or `typesys_aggregate`), and typed error codes over
  MCP, which needs structured tool errors first.

## Alternatives Considered

- **Infer from literal schemas with `as const`.** Rejected for the reasons
  in Context; it would also have meant two type-level code paths, one for
  TypeScript-authored domains and one for everything else.
- **A generic JSON Schema to TypeScript library.** It would not know the
  `x-` vocabulary (relationships, computed properties, Actions), which is
  most of what a client needs typed.
- **Required values in row types.** Rejected: a type that is wrong whenever
  policy withholds a value trains developers to ignore it.
