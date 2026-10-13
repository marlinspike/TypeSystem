# Roadmap: from governed runtime to governed composition platform

A living document. It records what this evolution is for, the order the
work runs in and why, what is done (with the evidence), and what is left.
It is updated in the same commit as the work it describes. For what exists
today regardless of this roadmap, [`completeness.md`](completeness.md) is
still the source of truth; for what stands between this code and
production, [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md).

## The goal, in one paragraph

TypeS already gives every consumer one governed path to enterprise data:
one model, one enforcement point, one audit trail. The next step is to make
that path the *fastest* way to build an application or an agent, not just
the safest one. A developer (or a coding agent) should be able to take a
mission requirement, discover the semantic capabilities that serve it,
compose a typed query, a governed workflow and a user interface over them,
check the composition mechanically before running it, and ship it with
very little handwritten integration code. Every one of those steps has to
keep the guarantee TypeS exists for: the runtime decides, once, for people
and models alike.

## Principles this roadmap is held to

- **Extend the boundary, never route around it.** Every new capability
  (SDK, workflows, previews, discovery, UI bindings) calls
  `SemanticRuntime`. Nothing new reads an adapter directly or decides
  policy on its own.
- **The model is the only schema.** Types are authored once (TypeScript,
  YAML or a store); the SDK's static types, the UI's forms and columns, the
  agent catalog and the HTTP API all derive from it.
- **Cohesive packages, small core.** Core gains only what must sit at the
  enforcement boundary (derived-value release, instance-scoped Actions,
  previews, computed filtering, execution plans). Everything else is a
  package with one job.
- **Deterministic and probabilistic work are different kinds of step.** An
  AI step proposes; only governed, deterministic steps commit.
- **Evidence over claims.** Each slice lands with tests (including attack
  tests where it touches enforcement), an ADR when the decision is hard to
  reverse, and an update to `completeness.md`. Productivity and performance
  claims are measured against the baseline below.

## Dependency order, and why

```
1 derived-value release (security fix)
2 instance-scoped Actions + Action previews ─────────────┐
3 computed filtering + explainable execution plans ──┐   │
4 typed SDK (inferred from the model) ───────────────┤   │
5 devkit: catalog, discovery, validation, diff ──────┼───┤
6 governed workflows + simulation + replay ──────────┘   │
7 governed HTTP API + headless React bindings ───────────┤
8 domain packs (versioned, specializable, offline) ──────┤
9 Studio ────────────────────────────────────────────────┘
10 mission application + productivity comparison
```

Derived values come first because every later capability (filtering on
computed properties, typed projections, previews, generated UI) would
otherwise multiply an existing leak: a computed property ran on unredacted
inputs, so a viewer could read `readinessStatus` (a one-to-one function of
the policy-hidden `maintenanceStatus`). Instance-scoped Actions and previews
come next because workflows, agents and simulation all need to ask "may
this caller do this to *this* object, and what would happen?" without doing
it. The query work precedes the SDK because the SDK compiles to the query
DSL and should not need client-side workarounds for computed filtering.

## Delivery

All work lands on one branch as a sequence of focused, individually green
commits, one per slice, under one draft pull request. Nothing is merged
without the owner.

## Status

Legend: ✅ done (with evidence) · 🚧 in progress · ⏳ not started

| # | Slice | Status | ADR | Evidence |
|---|---|---|---|---|
| 0 | Baseline measurements | ✅ | — | [`evidence/baseline-2026-10-13.md`](evidence/baseline-2026-10-13.md) |
| 1 | Derived values inherit their inputs' read policy; explicit, audited release | ✅ | [0052](adr/0052-derived-values-inherit-their-inputs-read-policy.md) | `packages/core/test/derived-value-release.test.ts`, 6 mutations caught |
| 2 | Instance-scoped Actions, `previewAction`, MCP Host/Origin checks | ✅ | [0053](adr/0053-instance-scoped-actions-and-previews.md) | `instance-scoped-actions.test.ts`, `http-origin.test.ts`, MCP tool tests; conformance DNS-rebinding scenario passes; 5 mutations caught |
| 3 | Filtering on computed properties; explainable execution plans | ✅ | [0054](adr/0054-computed-filters-and-execution-plans.md) | `computed-filter-pagination.test.ts` (60 generated queries vs a reference), 6 mutations caught |
| 4 | `@typesys/sdk`: a model generated from the registry and a fluent governed client | ✅ | [0055](adr/0055-typed-sdk-generated-from-the-registry.md) | `packages/sdk/test/` (12 compile-time refusals; SDK equals `runtime.query` for 3 callers in process and over MCP), 7 mutations caught; [`evidence/sdk-2026-10-13.md`](evidence/sdk-2026-10-13.md) |
| 5 | `@typesys/devkit`: capability catalog, agent discovery, composition validation, contract diff | ✅ | [0056](adr/0056-model-description-discovery-validation-and-contract-diff.md) | `packages/devkit/test/devkit.test.ts` (validator checked against the runtime over 1,620 generated filters), MCP and CLI tests, 7 mutations caught; [`evidence/devkit-2026-10-13.md`](evidence/devkit-2026-10-13.md) |
| 6 | `@typesys/workflow`: governed workflows, AI steps, approvals, simulation, replay | ⏳ | 0057 | |
| 7 | Governed HTTP API and `@typesys/react` headless bindings | ⏳ | 0058 | |
| 8 | Domain packs | ⏳ | 0059 | |
| 9 | TypeS Studio | ⏳ | 0060 | |
| 10 | Mission application and productivity comparison | ⏳ | — | |

## Decisions already made

- **Workflow durability.** Mature engines exist and are the right home for
  long-running production workflows: Temporal (a separate cluster, SDKs in
  several languages) and DBOS Transact (a library that checkpoints to
  Postgres). TypeS will not build a competing orchestrator. It defines the
  *governed* part a workflow engine cannot know about (which steps are
  authoritative, which are probabilistic, what needs approval, what each
  step may touch) and runs it through a small journaled interpreter whose
  job is preview, simulation, deterministic replay and tests. Durability
  sits behind a `WorkflowJournal` seam so that a Temporal or DBOS binding
  replaces the reference journal rather than the model. The reference
  journal is not claimed to be a production orchestrator.
- **Static typing without a second schema.** The SDK's model is generated
  from the registry, the one place `extends`, traits and computed
  properties exist composed, whether a domain was written in TypeScript,
  YAML, or loaded from Postgres. Inferring from literal schemas was planned
  first and dropped: domain entries widen their literals, and YAML and
  stored registries have no TypeScript source (ADR-0055). Committed models
  are checked for drift by regenerating.
- **Explain plans stay off MCP by default.** ADR-0038 kept `explainQuery`
  runtime-only because an authorization plan shows which attributes a
  policy tests. The execution plan added in slice 3 follows that rule:
  agents get a plan without authorization predicates.

## Remaining gaps (kept current)

Filled in as slices land. Production accreditation items stay in
`PRODUCTION-READINESS.md`; nothing here claims to close them.

- Sorting by a computed property, and batching computed properties across
  a page (the `needsAttention` hotspot in the baseline). Batching is
  planned with the mission application, where it is measured.
- An Action preview assumes preconditions have no side effects; there is
  no adapter-level dry run of the write itself (ADR-0053).
- `getObject` p50 is slower than the baseline (about 0.10 ms against
  0.078) across slices 1 to 4, not yet attributed; see
  [`evidence/sdk-2026-10-13.md`](evidence/sdk-2026-10-13.md).
- Discovery is lexical, measured on six hand-written tasks; it misses
  synonyms the model's words don't contain. The contract diff judges the
  declared contract, not behavior behind an unchanged schema.
- The SDK has no aggregate builder, and refusals over MCP arrive as text
  (`RemoteToolError`) because MCP tool errors carry no structured code.
