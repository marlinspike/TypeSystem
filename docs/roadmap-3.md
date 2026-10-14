# Roadmap 3.0: hardening, autonomous engineering, validation

A living document, updated in the same commit as the work it describes.
[`roadmap.md`](roadmap.md) records the 2.0 composition work this builds on;
[`completeness.md`](completeness.md) stays the source of truth for what
exists, and [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md) for what
stands between this code and production.

## What 3.0 is for

TypeSystem 2.0 made the governed path a fast way to compose an
application. 3.0 has three jobs, in this order:

1. **Make the foundation trustworthy enough to automate on.** An
   autonomous application inherits every gap in the boundary under it:
   a workflow that acts on permissions its initiator lost, a model that
   receives whatever its user may read, a run that a restart forgets, a
   model description any caller can enumerate.
2. **Make verification reproducible.** Every security claim must be
   regenerable from the repository, with the revision and environment it
   was measured on.
3. **Make a coding agent dramatically more effective, and measure it.**
   TypeSystem does not become a coding agent. It gives existing agents
   (Claude Code, or any other) the semantic contracts, planning, generation
   and verification that turn a requirement into a governed application,
   and an evaluation that would show it if that is not true.

## Principles

The 2.0 principles still hold: extend the boundary, never route around
it; the model is the only schema; a small core with packages that each do
one job; deterministic and probabilistic work are different kinds of step;
evidence over claims. Two are added:

- **A security property is stated as an invariant and attacked.** Tests
  that confirm the expected path are not evidence of a security property.
  Each mechanism in M2 lands with tests that try to break it, and its
  mutations are in the committed catalog (M3).
- **Measured, not asserted.** No productivity claim is made without the
  M6 evaluation behind it, including the dimensions where TypeSystem loses.

## Execution sequence

```
M1 product name + terminology check
 │
M2 foundations ────────────────────────────────────────────┐
 ├─ M2a workflow identity: continuing authority            │
 ├─ M2b release boundary: audiences for models             │
 ├─ M2c durable execution: Postgres journal, timers        │
 ├─ M2d discovery security: deployment modes               │
 └─ M2e pack and model integrity                           │
M3 reproducible verification (mutation harness, invariants)┤
 │                                                         │
M4 autonomous engineering loop (spec → plan → build → verify)
 │
M5 independent-systems interoperability  ──┐
M6 productivity evaluation (3 arms)  ◄─────┘ (M5's services are M6's unseen tasks' substrate)
 │
M7 reusable mission engineering + Studio (workflows, provenance, plans)
```

Why this order. M2 precedes M4 because an autonomous loop amplifies
whatever the boundary lets through: an agent that generates workflows
must generate them against a runtime where a revoked approver cannot act
and a model never receives what it was not cleared for. M3 follows M2 so
the new mechanisms land in the mutation catalog the moment it exists,
and M4 needs M3's harness because "verify" is a step of the loop. M5's
independent services give M6 a substrate that no 2.0 code was written
against, which is what keeps the evaluation from favoring prebuilt
scenarios. M7 last, because packs and Studio screens should package what
M4 to M6 proved useful rather than guess at it.

## Milestones and exit criteria

A milestone is done when every exit criterion holds on a commit that CI
has run green, and its evidence is committed.

### M1. Product name

- `npm run check:terminology` passes over every tracked text file and runs
  in CI; its tests show it catches the retired name in prose, identifiers,
  headers and Cedar namespaces, and passes TypeScript, TypeSys, TypeSystem
  and `typesys` identifiers.
- No published identifier changed except those that carried the retired
  name; ADR-0064 lists them.

### M2a. Workflow identity: continuing authority

- A run never acts on an identity older than its deployment's
  `identityMaxAgeMs` or past its `expiresAt` without re-resolving it.
- Before every effectful step (read, AI, Action, compensation) the engine
  re-resolves the initiator and re-decides the workflow's start policy for
  them; a revoked role, an expired credential, a removed subject or a
  policy change suspends the run (`waiting-reauthorization`) with nothing
  executed, audited as `workflow.reauthorize` deny.
- A suspended run resumes only for the same subject with a fresh identity
  the start policy admits, or is cancelled (compensating what completed).
- Approvals are decided with the approver's current identity at decision
  time, and an approval that a revocation makes impossible to give can
  time out (M2c).
- Attack tests: revoke mid-run between two Actions; expire a credential
  while waiting on an approval; change the policy between steps; resume as
  another subject; each is refused with nothing executed.

### M2b. Release boundary for models and execution environments

- An `audience` (a model or execution environment, with its own
  clearance, attributes and roles) can be bound to any identity. The
  runtime then allows a decision only when the person **and** the audience
  are allowed, at the one enforcement point: every policy decision, every
  classification decision, row-level planning, computed values, provenance,
  aggregation and Actions.
- Being allowed to read data never implies a model may receive it: with an
  audience bound, nothing reaches it that the audience itself is not
  granted, and the default grants an audience nothing.
- A workflow AI step's input is built by re-running its upstream reads and
  computes under the audience, so a value derived from withheld data is
  withheld too; a step that would send anything the model may not receive
  is refused unless it opts into redaction. Every release is audited with
  the audience. A workflow whose AI step depends on an Action's output is
  refused at registration.
- MCP and HTTP servers can bind the audience of the agent behind them, so
  an agent's model is governed exactly like a workflow's.
- Property tests over generated identities, audiences and objects: what
  the runtime returns with an audience bound is never more than either
  party alone would get.

### M2c. Durable execution

- `PostgresWorkflowJournal` passes the journal contract suite that the
  in-memory journal passes: atomic conditional append, concurrent writers
  refused, runs listed, waiting runs indexed.
- Durable timers: approval deadlines and retry backoff are journaled
  events; a process that dies while one is pending honors it after
  restart; `tick()` fires due timers and is safe to call from several
  processes at once.
- A recorded crash-and-recover test against real Postgres: two engines
  advance the same runs concurrently and no Action runs twice.
- An ADR records the decision on Temporal and DBOS: what binding the seam
  supports and why it is or is not shipped now.

### M2d. Discovery security

- A deployment chooses `discovery: "open" | "authenticated" | "need-to-know"`
  for MCP, HTTP and Studio. Under need-to-know, a caller's model
  description contains only Types they may read, members they may read,
  relationships to Types they may read, and Actions they may invoke, and
  the runtime decides it (not each transport).
- Tests show the same caller gets the same description over every
  transport, and an anonymous caller under `authenticated` gets a refusal.

### M2e. Pack and model integrity

- Pack trust stores can revoke a key; a pack signed by a revoked key is
  refused, and installing one is audited.
- Whatever M3's catalog and the independent review find in packs, model
  evolution, inheritance, computed properties, Actions or planning is fixed
  or recorded as an open gap with its reason.

### M3. Reproducible verification

- `npm run mutation` applies every mutation in a committed catalog, forces
  a full rebuild (`tsc -b --force`), runs the tests the catalog names,
  restores the file, and writes an evidence record: the git revision and
  whether the tree was clean, Node and OS, the catalog's hash, and each
  mutation's result. A survivor fails the run unless the catalog marks it
  equivalent with a reason.
- The catalog covers every security mechanism changed in M2 and the
  pressure-test high findings; the committed evidence record is the one CI
  can regenerate.
- Property-based invariant tests (fast-check) for the release boundary and
  for the read path ("a query returns no value a direct read would refuse").
- An independent adversarial review thread is run on the milestone, and
  its findings are fixed or recorded.

### M4. The autonomous engineering loop

- A machine-readable mission spec (`typesys.mission/1`): the requirement,
  the callers, and acceptance criteria written as checks the governed
  runtime can decide (who may see what, which Action is offered to whom,
  which workflow must hold for approval).
- `typesys engineer plan` turns a spec into a semantic plan: what the
  model already provides (Types, relationships, Actions, workflows), what
  must be created, and every diagnostic, with codes and fix hints.
- `typesys engineer scaffold` generates a working application from a plan
  (typed SDK client, workflow definitions, HTTP API, React view, and
  acceptance tests generated from the spec), and `typesys engineer verify`
  builds, typechecks, runs the acceptance criteria against the runtime and
  reports structured diagnostics an agent can act on.
- The same loop is offered to agents as MCP tools and as a Claude Code
  skill, provider-independent in its contracts.
- Demonstrated end to end: a requirement no existing code was written for
  goes from spec to a running, verified application, including a seeded
  defect diagnosed and repaired through `verify`.

### M5. Interoperability across independent systems

- At least three independently implemented services (separate processes,
  separate data models, separate authorization) exposed through governed
  semantic contracts, and a mission application composed across them.
- Scenarios with tests: latency, a failed service (partial results with
  provenance saying what is missing), schema evolution in one service
  absorbed by its adapter mapping with the consumer unchanged (byte for
  byte), and access control enforced by both the service and TypeSystem.

### M6. Productivity evaluation

- A harness that runs a task under three arms: conventional development on
  the original runtime, an AI agent without the composition platform, and
  an AI agent with it. Each arm gets the same requirement text and the same
  hidden, independently written acceptance tests, in an isolated workspace.
- Recorded per run: wall time, human interventions, tokens, code volume,
  first-pass acceptance, repair iterations and their success, defects found
  by the hidden tests, integration complexity, runtime performance, and a
  maintainability measure.
- At least three tasks, at least one written after M4 was finished.
- A report with every result, including losses, and why each loss happened.
  Runs that need paid model access beyond this environment are escalated
  with the expected cost before they are made.

### M7. Reusable mission engineering and Studio

- Packs carry workflows and sample data; a mission app is assembled from
  packs in a disconnected install.
- Studio screens for workflows (definition graph, runs, approvals),
  provenance, and query plans, each tested in Chromium.

## Status

Legend: ✅ done (with evidence) · 🚧 in progress · ⏳ not started

| Milestone | Status | ADR | Evidence |
|---|---|---|---|
| M1 product name | ✅ | [0064](adr/0064-the-product-is-typesystem.md) | `tools/terminology/test/terminology.test.ts`; `npm run check:terminology` in CI |
| M2a workflow identity | ✅ | [0065](adr/0065-workflows-act-on-continuing-authority.md) | `packages/workflow/test/continuing-authority.test.ts` (revocation, unknown subject, other subject, stale snapshot, expiry, policy change between Actions, cancel by policy); HTTP routes in `packages/http/test/api.test.ts` |
| M2b release boundary | ✅ | [0067](adr/0067-release-to-models-is-decided-for-the-model.md) | `release-boundary.test.ts` in domain-airforce (property-based intersection over generated principals), domain-hospital (row-level plan conjunction) and workflow; `packages/mcp-server/test/audience.test.ts`; Cedar parity with bound audiences |
| M2c durable execution | ✅ | [0066](adr/0066-durable-execution-on-the-journal-seam.md) | `packages/workflow/test/journal-contract.test.ts`, `packages/workflow-postgres/test/postgres-journal.test.ts` (contract on real Postgres, append-only trigger, crash recovered by two processes at once, deadline expired by another process); durable timers in `continuing-authority.test.ts` |
| M2d discovery security | ✅ | [0068](adr/0068-discovery-is-decided-by-the-runtime.md) | `packages/domain-airforce/test/discovery.test.ts` (need-to-know per caller and audience, property-based over generated principals, modes, `HIGH_ASSURANCE_V2`); `packages/mcp-server/test/discovery-security.test.ts` (one description over runtime, REST, MCP tools, resources and HTTP `tools/list`; anonymous refused); Studio in `packages/studio/test/studio.test.ts` |
| M2e integrity | ⏳ | | |
| M3 reproducible verification | ⏳ | | |
| M4 engineering loop | ⏳ | | |
| M5 interoperability | ⏳ | | |
| M6 evaluation | ⏳ | | |
| M7 reuse and Studio | ⏳ | | |

## Delivery

The work lands as focused, individually green commits on one branch under
one draft pull request, a milestone at a time; nothing is merged without
the owner. Independent adversarial reviews run as separate threads on the
pull request at the end of M2 and of M4.

## Continuation state

Kept current at each commit so the work can be picked up exactly where it
stopped.

- Done: M1, M2a, M2b, M2c, M2d. Next: M2e (pack key revocation, integrity
  findings), then the independent review of M2 and M3's mutation harness.
