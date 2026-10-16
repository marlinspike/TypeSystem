# 0076. Onboarding Proposes From Evidence, and an Expert Approves

## Status

Accepted (2026-10-16). Builds on ADR-0059 (packs), ADR-0072 (independent
services), ADR-0074 (models) and ADR-0075 (release to models).
Implemented in `packages/onboard/`, `PostgresTableAdapter` in
`packages/adapter-postgres/`, Actions in `packages/adapter-http/`, and
`replayAdapter` in `packages/llm/`. Proven by
`packages/onboard/test/onboard.test.ts`, `command.test.ts`,
`onboard-postgres.test.ts` (live PostgreSQL),
`packages/adapter-postgres/test/postgres-table-adapter.test.ts`,
`packages/adapter-http/test/http-actions.test.ts`, and `npm run
onboard:demo`, which CI runs against PostgreSQL 17.

## Context

Describing an existing database or service as TypeSystem Types is the
first thing every deployment does, and the slowest. The facts needed are
mostly already written down: in the database's catalog (keys, foreign
keys, checks, comments), in an OpenAPI document (schemas, operations,
scopes), in JSON Schemas. What is not written down is judgment: what a
table means in the business, which undeclared column is really a
reference, which field is personal, which operation is safe to offer.

A language model is good at the second kind of work and unreliable at
the first. Anything it says about a source can be wrong, and some of it
(a classification, an access rule) must never be decided by it. The
semantic model it helps produce governs who sees what, so an error is a
security defect, not a naming nit.

## Decision

**Evidence first, metadata only.** A collector turns each source into
`Evidence` records with stable ids: `pg:<source>/<schema>.<table>[.<column>]`
(and `#fk:`, `#check:`), `openapi:<source>#<JSON pointer>`,
`schema:<source>/<title>…`. Each record's text is what the source itself
says. PostgreSQL is read from `pg_catalog` alone; no row is ever read.
Sensitivity hints come from names and comments (`ssn`, `phone`, a
comment stating `CLASSIFIED: SECRET`).

**A deterministic baseline.** From evidence alone, `baseline()` proposes
a Type per entity, a property per field with its JSON Schema (a `CHECK
… IN` becomes an `enum`), relationships only where a constraint declares
them, sensitive fields from hints, a marking only where evidence states
it, Actions from command operations, and findings (a filter that is not
a field, a table without a key). Every item cites the evidence it rests
on and has a basis: `declared`, `derived` or `inferred`. It runs, and
the whole pipeline works, with no model.

**A model may refine, and everything it says is checked.** A development
model (ADR-0074, `use: development`) is sent the evidence and the
baseline and may rename and describe, propose relationships no
constraint declares, flag more sensitive fields, name Actions and report
findings. Its answer is validated against a closed schema by the model
layer, then against the evidence by `applyRefinement`: every cited id
must exist; a relationship's `to` must be a key and its types must
match; names must be valid and unique; a marking must be stated in text
the item cites; a sensitive flag can be added, never removed. What fails
is kept in `rejected` for the reviewer, never applied. The request is
labeled (ADR-0075), so a deployment whose metadata is itself marked is
refused a model that may not receive it. Evidence text is data: the
system prompt says so, and nothing a source's comment says can do more
than the schema allows, which is checked whatever the model answers.

**The model never writes policy.** Onboarding names the rules a
deployment must supply as slots: `<domain>.read-<type>`,
`<domain>.<category>` per sensitive category, `<domain>.invoke-<action>`.
It does not write a rule body.

**Agent mode.** The development model may be the coding agent the
engineer is already using. `typesys onboard request` prints the exact
request; the agent's answer is recorded with `requestKey` against that
request (`LlmRecording`, `producedBy` saying who answered) and replayed
through the model layer by `replayAdapter`, so it is validated, checked
and accounted like any model's. A replay answers only the request it
recorded: if the evidence changes, it refuses (`unavailable`) rather than
apply an answer to a different question.

**An expert approves; later runs keep what was approved.** Each item's
`fingerprint` is the digest of the evidence text it cites. A review is a
file of decisions, each pinned to a fingerprint and, for a rename, the
approved name. Types, properties, relationships and Actions are
installed only when accepted on their current evidence; an Action never
by default. A sensitive flag protects until an expert rejects it. When
the evidence an item cites changes, its decision lapses and the item is
asked about again; when evidence disappears, the decision is reported
orphaned. `carryForward` merges a new run into what was approved: an
approved item with unchanged evidence stays as approved, even when the
new run has no model or names it differently; only new or changed items
are pending.

**Verification uses the existing tools.** The approved model is built
into a pack (ADR-0059), installed into a fresh registry with its policy
slots, and compared with the previous pack by `checkUpgrade`. Generated
checks then run through a real runtime against the live sources:
`reads`, `conforms` (values against the schema), `gets` (one object read
alone equals the same object in a query), `follows` (each relationship
lands where its key says), `protects` (a sensitive property is withheld
without its rule) and `marks` (a marked property is withheld below its
marking). A check the data cannot decide is `inconclusive`, never
passed.

**Adapters from the proposal.** PostgreSQL entities read through
`PostgresTableAdapter`: one table or view per Type, quoted identifiers
validated when the adapter is built, parameterized SQL, `eq` conditions
on plain columns pushed down and every condition decided by
`matchesFilter`, codes mapped, dates and numerics converted, and a list
too long to answer whole refused rather than truncated. It never writes.
OpenAPI entities read through `HttpAdapter`, which now executes Actions:
path parameters encoded (`.` and `..` refused), only mapped fields sent,
a token renewed once on 401, a 401/403 a `SourceRefusedError`, and
nothing retried once the service has answered. Credentials are named by
environment variable in `adapters.json`, never written there.

## Consequences

- Onboarding is a reviewable diff: `proposal.json`, `review.json` and
  `approved.json` are committed beside the pack, and a rerun shows only
  what changed in the sources.
- The model's contribution is measured on each run: items proposed,
  refused, approved and pending; tokens, latency and cost.
- The example's development-model answer was written by a coding agent
  in agent mode and is labeled so in its recording. No configured
  provider has been run against it from this repository.
- Not addressed: column-level views or joins as one Type, relationships
  across sources resolved inside one SQL query, OpenAPI `allOf`/`oneOf`
  compositions, MySQL and other catalogs, and onboarding tools over MCP.
