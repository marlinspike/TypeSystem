# 0075. A Model Receives Only What Its Audience May, Wherever a Call Is Routed

## Status

Accepted (2026-10-16). Amends ADR-0067. Implemented in `packages/llm/`
(selection, release, fallback), `packages/core/src/runtime/runtime.ts`
(Action results), `packages/mcp-server/` and `packages/demo-web/`
(bound hosts) and `packages/workflow/src/engine.ts` (workflow fallback,
transitive release, approver views). Proven by
`packages/llm/test/routing.test.ts`,
`packages/workflow/test/model-fallback.test.ts`,
`packages/domain-airforce/test/action-result-release.test.ts` and
`packages/mcp-server/test/audience.test.ts`.

## Context

ADR-0067 made a model a principal: a read for an agent is decided for the
person and for the model's audience. With real models (ADR-0074) three
new routes appear by which data can reach a model the runtime never
decided for: a call routed to a different model than the one asked for,
a fallback taken when a model is down, and content assembled outside the
runtime (a prompt built from files, or from an earlier model's answer).
ADR-0067 also left four gaps open, listed in `docs/completeness.md`:
Action results returned to a bound agent undecided, an approver shown
compute and AI outputs unchanged, no shipped host binding an audience,
and an answer passing on without regard to what its model was given.

Being allowed to read data is not permission to send it to a model, and a
fallback is a send.

## Decision

**Each configured model is an audience.** Its configuration names the
`Audience` the runtime decides for, and `resolveConfig` refuses one whose
derived attributes (provider, environment, served model, retention,
training) disagree with its provider's configuration, so a policy keyed
on `environment` cannot be told `enclave` for a hosted API.

**Content not read through the runtime carries a label.** A request
may carry `{ markings }`, decided against the model's audience with the
deployment's classification scheme (deny-biased: marked content with no
scheme is refused). A deployment can require labels on every request.
A refusal names nothing about the content.

**Selection is explicit first.** `llm.model(id, use)` is the normal path.
`llm.select(requirements)` picks among configured models by use,
capabilities, environment, release of the request's label and a
declared quality order, and explains every rejection.

**Fallback is a new release, never a reroute.** Only `unavailable`,
`overloaded`, `rate-limited` and `timeout` fall back; a refusal, an
invalid answer or an authorization failure does not. Each fallback is
admitted as if called directly: configured for the use, capable of the
request, and the content releasable to its audience. Environments are
ordered `local` < `private` < `hosted`; a fallback outside the primary's
boundary is taken only when the primary's configuration sets
`crossBoundaryFallback` **and** the request is labeled. So a local model
failing never sends unlabeled content to a hosted provider. Every
fallback taken or refused is recorded.

**In a workflow, the engine decides each fallback's release.** An
`AiModel` may list fallbacks; `workflowModel` offers only those inside
the primary's boundary (unless configured otherwise) and configured for
runtime use. When the model fails retryably, the engine computes the
step's input again for the next fallback's audience, from what the
runtime decides that audience may read; a fallback refused the input is
skipped and never called. The move is journaled (`step-started` with
`model`) and audited (`workflow.fallback`), and the run replays.

**An answer is made of what its model was given.** A later AI step, or a
fallback for it, receives an earlier AI step's answer only if it may
receive everything that earlier model was given (the `released.needs` on
the journal). An approver is shown an AI answer on the same rule, reads
and Action results as they may read the objects in them, and each
compute as recomputed from what they may see. So a compute over a SECRET
value shows a CUI approver what it makes of the value withheld, not of
the value.

**An Action's result is released like a read.** The effect has happened;
what goes back to a caller reading for a model is the object the result
is (the Action's declared `outputType` named by the result's `id`, or its
target when the result names it), read as the person and the audience,
keeping only values that read returns. A result describing no object the
runtime can decide is withheld (`{}` or `null`). The audit row records
the audience and what was withheld. `ActionDefinition.outputType` is new
and persisted by the Postgres registry store (migration 0006).

**Hosts bind the audience.** `createServer` and the HTTP transport take
an `audience` option. The demo MCP hosts bind the audience named by
`TYPESYS_AGENT_MODEL` from the model configuration, and refuse to start
if it names a model that is not configured.

**Content read for one audience stays with it.** Content the runtime
released to a model's audience (read as `withAudience(person,
model.info.audience)`) is labeled by what it holds, but the label does not
say what was left out for that audience. Such a request names the audience
in `releasedFor`. Only a model with that audience id receives it, and a
fallback with another id is refused whatever the label. A deployment that
gives several models one audience id says they may stand in for one
another. A selection (`select`) falls back only to models that meet its
requirements. An Action that declares an `outputType` has its result
released as a read of that object to a person too, not only to an
audience. (Added after the M3 review, `docs/reviews/m3-adversarial-review.md`.)

## Consequences

- A deployment with no labels and no classification scheme cannot fall
  back across a boundary at all. That is deliberate.
- Approvers may see less than before. A workflow whose approval presents
  a compute over data the approver may not read now presents what that
  compute makes of the withheld value, often `undefined` or `false`.
- An Action without `outputType` returns nothing to an agent bound to a
  model, unless its result names its target. Domain authors declare
  `outputType` to give agents the result.
- Still open: release decided by provenance (each value's source rather
  than the object it is on), and a model observing that a step was skipped
  (ADR-0067, amended).
