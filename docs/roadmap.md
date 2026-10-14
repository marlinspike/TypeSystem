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
| 6 | `@typesys/workflow`: governed workflows, AI steps, approvals, simulation, replay | ✅ | [0057](adr/0057-governed-workflows.md) | `packages/workflow/test/` (crash recovery without repeating a non-idempotent Action; start and approval decisions identical under Cedar), `packages/devkit/test/synthesize.test.ts`, 11 mutations caught; [`evidence/workflow-2026-10-13.md`](evidence/workflow-2026-10-13.md), which also records a core fix: one request context per process instead of one per runtime |
| 7 | Governed HTTP API and `@typesys/react` headless bindings | ✅ | [0058](adr/0058-governed-http-api-and-headless-react-bindings.md) | `packages/http/test/api.test.ts` (8 SDK reads identical in process and over HTTP for 3 callers; OpenAPI request schemas admit and refuse what the runtime does), `packages/react/test/react.test.ts` (same component, different values per caller), 14 mutations caught; [`evidence/http-react-2026-10-13.md`](evidence/http-react-2026-10-13.md) |
| 8 | Domain packs: versioned, signed, offline, specializable | ✅ | [0059](adr/0059-domain-packs.md), [0060](adr/0060-subtypes-keep-their-base-protections.md) | `packages/packs/test/packs.test.ts` (core and airforce installed from their files are the same model and answer 3 callers identically; one install reports every missing requirement and registers nothing; upgrades checked against dependents), `packages/cli/test/pack.test.ts`, `packages/core/test/subtype-protections.test.ts`, 24 mutations caught; [`evidence/packs-2026-10-13.md`](evidence/packs-2026-10-13.md), which also records a core fix: a subtype no longer drops its base's property policies and markings |
| 9 | TypeS Studio | ✅ | [0061](adr/0061-typesys-studio.md) | `packages/studio/test/` (security headers; the API beside the page answers each caller as the runtime does; Chromium drives the built client as the viewer and the maintainer: a suggestion applied, the SECRET column empty only for the viewer, Invoke offered only for a previewed input that would run), `packages/sdk/test/source.test.ts` (2,000 generated queries round-trip through `querySource`), 21 mutations caught; [`evidence/studio-2026-10-13.md`](evidence/studio-2026-10-13.md) |
| 10 | Mission application and productivity comparison, with computed reads coalesced | ✅ | [0062](adr/0062-coalesced-computed-reads.md), [0063](adr/0063-a-mission-application-composed-and-by-hand.md) | Coalescing: `packages/core/test/read-coalescer.test.ts`, `packages/domain-airforce/test/computed-read-coalescing.test.ts` (identical answers for 3 callers over 3 generated fleets), 13 mutations caught; [`evidence/computed-reads-2026-10-13.md`](evidence/computed-reads-2026-10-13.md): 225 maintenance calls per page become 12 to 14, and p50 falls 20% to 30%. Mission application: `packages/mission-readiness/test/` (Chromium drives the composed and the hand-written versions through one scenario as a viewer, a maintainer and a lead, and both must show the same), 22 of 24 mutations caught, 2 equivalent; [`evidence/mission-app-2026-10-13.md`](evidence/mission-app-2026-10-13.md): 193 lines against 355, no access rule restated against 4 distinct rules at 7 places, five of six shared seeded mistakes caught by the compiler instead of the browser, three hand-written-only mistakes (two of them holes) caught by nothing, a policy change followed with no edit, the same latency |
| 11 | Independent pressure test of slices 1 to 10 | ✅ | — | `packages/*/test/pressure-*.test.ts` (50 cases that failed before the fixes, about 35 defects, six high severity, all fixed); [`evidence/pressure-test-2026-10-14.md`](evidence/pressure-test-2026-10-14.md), which also lists the evidence claims that did not hold: mutation counts cannot be re-run because no harness is committed, and the composed mission client types one response shape by hand |

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

- Sorting by a computed property. Coalesced computed reads (ADR-0062)
  cut the `needsAttention` hotspot's calls about 16 times but its time
  only 20% to 30%, since `maxConcurrency` still bounds round trips; they
  are opt-in, and slower where lookups are cheap or empty.
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
- Workflows have only an in-memory journal: no Postgres journal and no
  Temporal or DBOS binding yet. Retry backoff sleeps in process (no durable
  timers), approvals have no deadline, steps run one at a time, and nothing
  checks that what an AI step sends a model is within what that model may
  receive (ADR-0057).
- The HTTP API sends no CORS headers (same origin or a proxy is assumed),
  has no ETags or streaming of workflow state, and costs about 1.2 to
  1.5 ms per call over loopback. `formFields` covers top-level inputs
  only, and the React bindings are tested on React 18 only. The demo
  console keeps its own routes (ADR-0058).
- Packs carry no workflows or sample data, YAML domains cannot be packed
  (YAML has no data sources or mappings), and there is no pack registry,
  key revocation or uninstall (ADR-0059). A subtype cannot yet tighten an
  inherited value's rule or marking, only add where the base has none
  (ADR-0060).
- The mission comparison measures code and caught mistakes, not the time
  either version took to write; both were written by one author who knew
  the domain, and its seeded mistakes are a hand-chosen list (ADR-0063).
  The hand-written version's grounding process has no journal, retries or
  recovery, which the scenario does not exercise. A list of values an
  application writes beside the SDK is typed only if its author types it
  against the model.
- The Studio has no sign-in flow beyond pasting a token (or a proxy that
  adds one), no workflow, aggregation or provenance screens, does not edit
  the model, has no query completion, and is tested in Chromium only
  (ADR-0061).
