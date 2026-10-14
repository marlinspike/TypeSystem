# 0056. One Model Description, for Discovery, Validation and Contract Diff

## Status

*Amended (pressure review of PR #11):* the contract diff now also reports
what `schemaToTs` cannot see. A stored value or Action output that was
required and becomes optional is breaking. Constraint keywords are compared
(`type` integer vs number, `minimum`/`maximum` and their exclusive forms,
`min`/`maxLength`, `min`/`maxItems`, `format`, `pattern`, `multipleOf`):
on an Action input a change that admits fewer values is breaking and one
that admits more is compatible; on a value read, one that admits more is
risky and one that admits fewer is compatible; a change that is neither
(a different `pattern`) counts as both. An Action input closed off with
`additionalProperties: false` is breaking, and so is removing a
relationship alias the runtime resolved. `validateQuery` looks up values as
own properties only, so `constructor` or `toString` is reported as unknown.
The diff still sees no protections, since the description carries none;
`checkUpgrade` compares those separately (ADR-0059, amended). Proven by
`packages/devkit/test/pressure-diff.test.ts` and `pressure-validate.test.ts`.

Accepted — implemented in `@typesys/core` (`describeModel`,
`ModelDescription`), the new `@typesys/devkit` (`compactCatalog`,
`discover`, `validateQuery`, `diffModels`), `@typesys/mcp-server`
(`typesys_discover`, `typesys_validate_query`), `@typesys/cli`
(`describe`, `diff`, `discover`, `check-query`), and `@typesys/sdk`, whose
model generator now takes a `ModelDescription`. Proven by:

- `packages/devkit/test/devkit.test.ts`: the compact catalog of the
  airforce registry is under a third of `typesys_list_types` for the same
  Types; discovery ranks the intended Type or Action first for six tasks
  written before ranking was tuned, and returns nothing for a synonym the
  model does not contain; `validateQuery` names each mistake by JSON
  Pointer with the name probably meant; and it is checked against the
  runtime over 1,620 generated filters (every value of two Types, every
  operator, ten values of every kind): every query it accepts, the runtime
  accepts; every query it says can never match returns no row or is
  refused; every condition it says filters nothing returns every row.
  `diffModels` classifies removed, added, retyped and renamed values,
  relationships, enum members, Action inputs, outputs and scope, and names
  each Type or Action whose version did not move far enough.
- `packages/mcp-server/test/discovery-tools.test.ts`: the two tools over
  MCP; a `typesys_discover` answer is under a tenth of `typesys_list_types`.
- `packages/cli/test/generate-sdk.test.ts`: `describe` then `diff` passes an
  unchanged model and fails a breaking change; `check-query` reports a
  value outside an enum.

Mutation-checked (7 mutations): the operator check skipped; `ne` of an
impossible value reported as never matching; a removed enum member called
risky; a sufficient version bump reported as insufficient; Type names not
weighted in ranking; a computed top-level sort accepted; a relationship
alias ignored by the diff. Each fails at least one test.

## Context

The baseline found an agent discovering the model by reading every Type's
full schema, with no ranking and no way to check a composed query before
running it, and no way to tell whether a change to a model breaks the
applications and agents built on it. The typed SDK (ADR-0055) had also
grown its own flattening of `extends` and traits, which discovery,
validation and diffing would each have needed again.

## Decision

**One description of the model, in core.** `describeModel(registry)`
returns every Type with `extends` and traits composed, its computed values
with their schemas, relationships, Actions and aliases, and every Action's
input, output and scope, sorted by name, as plain JSON (`typesys.model/1`).
It is the contract and nothing about enforcement: no policy names, mappings,
data sources or bindings. The SDK's generator, discovery, validation and
the diff all read it, so there is one flattening. It lives in core because
composition is the registry's job (ADR-0004).

**Discovery is compact and ranked, and lexical.** `compactCatalog` writes a
Type in a few lines (values with their types, computed values,
relationships, Actions) and an Action in three (scope, effects, input).
`discover(model, task)` ranks Types and Actions with BM25 over their names
(weighted), descriptions, value, relationship and input names, and enum
members, with a small stemmer and stop-word list. It is deterministic and
needs no model or index service; it does not know synonyms the model's own
words don't contain, and says so. MCP's `typesys_discover` is the first
step of the agent's discovery sequence; `typesys_list_types` remains.

**Validation tells the model's truth, never the caller's.** `validateQuery`
runs the runtime's own shape and limit checks (`InputValidator`), then
checks every Type, value, relationship, projection, sort and search
property against the model, and every operator and value against the
shared filter interpreter's semantics (ordering only on numbers,
`icontains` on strings, `contains` on arrays, enum membership). Unknown
names come with the name probably meant. `error` means the runtime refuses
the query or it can never match; `warning` means it runs but probably not
as meant (`ne` a value the property never has; a deprecated alias). It
reads no data and decides nothing about authorization; `valid` says so.

**Discovery and validation disclose nothing new.** Both read only the
model, which `typesys_list_types` already gives any caller.

**The contract diff classifies by consumer impact.** `diffModels(before,
after)` marks each change `breaking` (code written against the old model
fails or misreads), `risky` (it keeps working but may meet something new:
a new enum member in a value it reads, changed side effects, a relationship
renamed behind an alias) or `compatible` (additions no caller can notice).
Direction matters: a new enum member is risky in a value read and
compatible in an Action input; a removed one is breaking in both. A change
of Action scope (ADR-0053) is breaking. It also reports each Type or Action
whose semver did not move as far as its changes need (major for breaking,
minor otherwise; before 1.0 a minor bump counts as major). `typesys diff`
exits 1 on any breaking or under-versioned change, which is the CI gate.

## Consequences

- An agent can go from a task to the right Type and Action in one small
  call, check the query it composed, see how it would run, and only then
  run it.
- A domain team can commit `typesys describe` output and gate a model
  change on `typesys diff` in CI.
- Discovery quality is lexical and measured only on a small hand-written
  set; a semantic ranker would sit behind the same `discover` signature.
- The diff judges the declared contract. A behavior change behind an
  unchanged schema (a compute binding that now returns different values, a
  policy that now denies) is invisible to it; policies have their own
  analysis (ADR-0031, ADR-0039).

## Alternatives Considered

- **Embedding-based discovery.** Better on synonyms, but needs a model and
  an index in every deployment, including disconnected ones (roadmap
  slice 8), and is not deterministic. Left as a drop-in behind `discover`.
- **Validation inside `SemanticRuntime.query`.** The runtime already
  refuses what it must; the rest (unknown names, filters that can never
  match) is advice that belongs before a query is run, not a new refusal
  that would change behavior for existing callers.
- **A diff of raw JSON Schemas.** It cannot tell a read value from an
  Action input, so it cannot say which direction of an enum change breaks.
