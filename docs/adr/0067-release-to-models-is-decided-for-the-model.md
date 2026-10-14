# 0067. Release to a Model Is Decided for the Model

## Status

Accepted (2026-10-14). Implemented in `@typesys/core` (`Audience`,
`Identity.audience`, `withAudience`, `audienceIdentity`, `bindAudience`,
`decideForIdentity`; the runtime's policy, classification and planning
decisions), `@typesys/workflow` (`AiModel.audience`, release of AI step
inputs, `release: "redact"`, the `unreleasable-ai-input` diagnostic,
`ReleaseRefusedError`, `SimulationScript.audience`) and
`@typesys/domain-airforce` (`demoAudiences`, the `ai-enclave` role in two
rules, ABAC and Cedar).

Proven by:

- `packages/domain-airforce/test/release-boundary.test.ts`: a maintainer
  reading for a commercial model is refused the Aircraft, its query and
  its Action; reading for the enclave model gets what a maintainer reads
  except the SECRET location the maintainer sees; a viewer bound to the
  enclave model gets no more than a viewer; every decision is audited with
  the audience. Property-based (fast-check, fixed seed, 120 and 60 runs
  over generated roles and clearances for both principals): a read for
  person and audience is exactly the intersection of what each reads
  alone, refused when either is; a query returns no object or value
  either could not read.
- `packages/domain-hospital/test/release-boundary.test.ts`: row-level
  release plans the conjunction of both plans, so a clinician reading for
  another team's model gets no patient, and the pushed-down plan names both
  providers.
- `packages/workflow/test/release-boundary.test.ts`: the enclave model
  receives the triage input and the release is audited; a commercial
  model, or one with no audience, is refused before it is called; a step
  that would send the SECRET location is refused although its initiator may
  read it; `release: "redact"` sends the model the input without it, and
  the run replays; a compute over the withheld value is recomputed and
  withheld too; an AI step fed by an Action is refused at registration; a
  simulation releases as a live run does.
- `packages/mcp-server/test/audience.test.ts`: an MCP server bound to its
  agent's model answers the maintainer's agent on the enclave model without
  the SECRET value, and refuses the same maintainer's agent on a commercial
  model.
- `packages/policy-cedar/test/parity.test.ts`: ABAC and Cedar decide
  identically for identities bound to audiences.

## Context

Every read in TypeSys was decided for the person asking. When that person
was an AI agent's user, or a workflow's initiator with an AI step, whatever
they could read could be sent to a model: the policy said who may *read*
it, and nothing said who may *receive* it. A maintainer cleared SECRET
could have a commercial API summarize a SECRET deployment location. The
pressure test and ADR-0057 both named the gap ("nothing checks that what an
AI step sends a model is within what that model may receive").

A release decision has the same inputs as a read decision (a principal,
its roles and attributes, a clearance, the data's policy and markings), so
it should not have a second engine or a second rule language.

## Decision

**A model is a principal, and release is a conjunction.** An `Audience`
(a model, an execution environment, a service) has an id, roles,
attributes and a clearance, granted to it by policy like anyone's, and
granted nothing by default. An identity may be bound to one audience. The
runtime then makes every decision for both principals, at the one
enforcement point: each policy decision (`decide`), each classification
decision (`classify`), the read plan pushed into a store (`allPlans` of
both plans, sound because each is), and the plan's assurance (structural
only if both are). The person is decided without the audience attached, so
no rule can mistake one for the other. A refusal by the audience reads
"Not releasable to `<audience>`", and every audit row of a bound identity
carries `details.audience` (and `audienceClearance` for classification).

**Hosts bind audiences, callers cannot.** `bindAudience(resolver,
audience)` wraps an `IdentityResolver`: an MCP or HTTP server an agent
talks through names the model behind that agent, and everything the agent
reads is decided for its user and its model. An identity cannot be
re-bound to a different audience.

**An AI step's input is computed from what its model may receive.** The
engine re-runs the step's upstream reads, and recomputes its computes, as
the person carrying the run bound to the model's audience, so the runtime
decides every value (and anything derived from a withheld value is
withheld, because it is recomputed from what the model may receive). Model
answers and approvals pass as journaled; an Action's output cannot be
re-read as the audience, so registration refuses an AI step that depends
on one. The step's `input` function is called on those outputs. If that
differs from what the person alone would have sent, the step is refused
(`ReleaseRefusedError`, not retried) unless it declares `release:
"redact"`. Every release is audited as `workflow.release`, allow or deny,
with the audience and the needs that differed. The released needs are
journaled with the step, and replay checks the step against them.

**The demo grants explicitly.** The airforce domain's enclave model holds
`ai-enclave`, which two rules admit, and is cleared CUI; the commercial
model holds nothing. The same maintainer, the same workflow: the enclave
model triages, the commercial model is refused, and a step that tries to
send the SECRET location is refused for both.

## Consequences

- Being allowed to read data no longer implies it may go to a model, and
  the decision about the model is made where every other decision is, with
  the same policy language, the same classification scheme and the same
  audit.
- Release rules live in the read policies. A deployment that wants a
  separate "release" vocabulary can still write it, by giving audiences
  roles only release-specific rules admit.
- An AI step costs a second read of its upstream data, as the audience.
- Not addressed: provenance-based release (a value released because of
  where it came from rather than its Type's policy), transitive release
  (what a model's answer may then be sent to), the run's own input (typed
  by the initiator, sent as given), the runtime's own handling of a
  model's *output* (an AI step's output is journaled and governed as the
  workflow's, ADR-0057), and a reviewed release scheme for real markings.

## Amended after the independent review (2026-10-14)

The review ([`docs/reviews/m2-adversarial-review.md`](../reviews/m2-adversarial-review.md))
found three High-severity and three lesser gaps. All are fixed, each with
its test and a catalogued mutation:

- **Run outputs (H1).** `WorkflowEngine.outputs` refuses a caller reading
  for an audience unless the run read for that same audience. Before, an
  agent API bound to a commercial model returned what a run started from the
  people's UI had read, the SECRET location included.
- **Re-resolution (H2).** A re-resolved, re-authorized or self-cancelled
  run keeps the audience it was started for, never one the resolver
  supplies under the same id. An identity that now reads for a different
  audience suspends the run.
- **Conditions (H3).** Releasing an AI step's input decides every upstream
  step's `when` again on what the model may receive. A step the model's
  view would skip contributes nothing, and a step the person's view skipped
  but the model's would run is run again as the model may see it. An AI
  step whose own `when` holds only on data the model may not receive is
  refused, whatever its `release` says.
- **Refusals (M8).** A caller reading for an audience is told only
  `Refused while reading for <audience>`, whatever was refused and why.
  Before, "Not releasable" appeared exactly when the person could read the
  row, which told the model the row existed. The audit row keeps the full
  reason.
- **Audit (L6, L7).** The audit row for an Action's outcome, and every
  workflow audit row, carries the audience its subject reads for.

One limit remains, by design. Whether an AI step runs is the workflow's
decision on the person's data. A step that the person's data skips, and
that would run on what the model may receive, is skipped, so the model is
not called, and the absence of that call is one bit about withheld data. A
model that sees every call it receives could count them. Write an AI step's
`when` over what its model may receive.

Seen in the review's code reading but not demonstrated, and still open:

- `invokeAction` over MCP and HTTP returns an Action's result to a bound
  agent without deciding it for the audience.
- `asSeenBy` passes compute and AI outputs to an approver unchanged.
- No shipped host calls `bindAudience`.
