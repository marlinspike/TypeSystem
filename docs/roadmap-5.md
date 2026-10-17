# Roadmap 5: semantic intelligence and the engineering workbench

This document is updated in the same commit as the work it describes.
[`roadmap-4.md`](roadmap-4.md) records the application compiler this
builds beside. [`completeness.md`](completeness.md) stays the source of
truth for what exists.

## What this is for

TypeSystem's purpose is a governed semantic substrate: one model of many
enterprise systems that people and AI agents discover, understand, compose
and operate through one enforcement point. The 4.0 compiler and
`@typesys/ui` stay supported. This work returns to the substrate itself
and makes it easy for an expert developer, or a coding agent working for
one, to answer these questions without reading the source:

- What do these systems represent, and how do their objects relate?
- Where does each value come from, and what guards it?
- What may this identity read and do, and why is something refused?
- What does a change to a Type, Action or policy reach, and what did it
  actually change?

## Architectural review

The review read the runtime, the registry, devkit, the context compiler,
the MCP server, the HTTP API, Studio, the workflow engine and the
compiler, and ran the existing multi-source examples (airforce over two
sources, Cold Chain over three independent services).

**What is strong and must not be duplicated.** `SemanticRuntime` is the
only caller of the policy engine and the only writer of audit rows. Every
member read is decided separately (object policy, member policy,
classification, derivation through `dependsOn`, releases), and each
decision is audited with its reason. Need-to-know discovery
(`narrowModel`) already guarantees that a description never names what it
withholds. `explainQuery`, `previewAction`, `diffModels`, `diffApps` and
`compileContext` each answer one question well.

**Gaps found.**

1. *The enforcement structure is invisible to the people who maintain
   it.* `ModelDescription` deliberately carries the consumer contract and
   nothing about enforcement: no sources, mappings, policies or markings.
   A developer who wants to know which system a value comes from, or which
   rule hides it, reads the domain's TypeScript. There is no governed way
   for an authorized developer to see that structure.
2. *Refusals are decided precisely and explained to nobody.* The runtime
   knows exactly why `maintenanceStatus` is missing for the viewer
   (member policy `airforce.maintainer-only`) and why `readinessStatus` is
   missing (derived from it, not released), and writes both to the audit
   log. The caller sees only absence. `explainQuery` covers queries and is
   kept in-process.
3. *Dependencies live in three disconnected places.* The model diff knows
   Types and Actions, the application diff knows pages, flows and checks,
   and workflows reference Actions and policies in code. Nothing connects
   an application's check back to the member, source and policy it rests
   on, so "what depends on this?" has no answer.
4. *The context compiler ranks words, not dependencies.* It expands one
   hop (relationship targets, Actions on a Type) and can include a
   computed value without the inputs it is computed from, or an Action
   without its target Type. It knows nothing of workflows, applications or
   checks, and it cannot tell the agent which statements are authoritative
   and which are inferred from a probe.
5. *Cross-source links are found by reading code.* In Cold Chain,
   `Shipment.origin` and `Shipment.destination` hold `Site` ids from a
   different service and no relationship declares it. A declared
   relationship whose foreign key dangles is silently omitted at run time
   (ADR-0048), so a broken link between two services looks like an empty
   list.
6. *Studio shows the model as lists.* There is no way to see composition,
   derivation, sources, guards or dependents, and nothing about why a
   caller sees what it sees.

**Overlaps, and what is done about them.** The repository has four CLIs
(`typesys`, `typesys-engineer`, `typesys-onboard`, `typesys-app`) and four
MCP servers, but `typesys` already dispatches to the other three, so
everything here is added to `typesys` and to the main MCP server: no new
binary, no new server and no new package. The three diffs are kept and
joined through one dependency graph rather than replaced by a fourth. The
3.0 mission format remains for migration only (ADR-0086); nothing new
targets it.

## Principles

- **Inspection never widens discovery.** An inspector sees enforcement
  structure only for what they could already learn of, and only when a
  deployment's inspection policy admits them. With no policy configured,
  nobody may inspect.
- **An explanation is the runtime's own decision, replayed.** Explanations
  are produced by running the real operation as the subject, capturing
  the decisions the runtime makes, and discarding every value. There is no
  second evaluator to drift from the first.
- **Every statement says how it is known.** Structural (from the
  definitions), evaluated (decided now by the runtime), observed (from the
  audit log), inferred (from a sample or a heuristic), or withheld (by
  count only).
- **Static analysis predicts; the runtime decides.** Impact analysis and
  explanations never claim that an operation will succeed.
- **Small surfaces.** New capabilities are functions on the existing
  runtime, devkit, workflow and compiler packages, exposed through the
  existing CLI, MCP server, HTTP API and Studio.

## Slices

| Slice | What | ADRs | Evidence |
|---|---|---|---|
| 1 | Governed inspection of the enforcement structure, and policy descriptions | [0088](adr/0088-an-authorized-developer-may-inspect-the-enforcement-structure.md) | `packages/domain-airforce/test/inspect-explain.test.ts`, `packages/core/test/policy-describe.test.ts` |
| 2 | Explanations replayed through the runtime's own decisions | [0089](adr/0089-an-explanation-is-the-runtimes-own-decision-replayed.md) | `packages/domain-airforce/test/inspect-explain.test.ts`, `packages/workflow/test/explain.test.ts` |
| 3 | One dependency graph over model, sources, policies, workflows, applications and checks | [0090](adr/0090-one-dependency-graph-over-model-governance-and-consumers.md) | `packages/devkit/test/graph.test.ts`, `packages/compiler/test/uses.test.ts` |
| 4 | Studio as a semantic workbench, and the same questions over HTTP, MCP and the CLI (Milestone A) | [0091](adr/0091-studio-is-a-semantic-engineering-workbench.md) | `packages/studio/test/workbench.test.ts` (Chromium), `packages/http/test/workbench.test.ts`, `packages/mcp-server/test/workbench-tools.test.ts` |
| 5 | Task-aware context for coding agents (Milestone B) | [0092](adr/0092-task-aware-context-says-how-each-statement-is-known.md) | `packages/devkit/test/context-v2.test.ts`, the context cases in `packages/mcp-server/test/workbench-tools.test.ts` and `packages/compiler/test/uses.test.ts` |
| 6 | Change impact, predicted and observed (Milestone C) | [0093](adr/0093-change-impact-is-predicted-from-definitions-and-observed-on-decisions.md) | `packages/devkit/test/impact.test.ts`, `packages/studio/test/impact.test.ts` (Chromium), the impact cases in `packages/compiler/test/uses.test.ts`, `packages/http/test/workbench.test.ts` and `packages/mcp-server/test/workbench-tools.test.ts`; `npm run impact:demo` |
| 7 | Links across systems, resolved in place and probed | [0094](adr/0094-links-across-systems-are-resolved-in-place-and-probed.md) | `packages/cold-chain/test/links.test.ts`, `packages/devkit/test/links.test.ts`, `packages/adapter-http/test/http-adapter.test.ts` |
| 8 | Productivity and architectural evaluation (Milestone D), and the defect it found | [0095](adr/0095-a-read-returns-only-what-the-model-declares.md) | [`docs/evidence/semantic-workbench-2026-10-17.md`](evidence/semantic-workbench-2026-10-17.md), `scripts/measure-workbench.ts`, `packages/core/test/declared-values.test.ts` |
| 9 | Pressure test and its fixes | amendments to [0089](adr/0089-an-explanation-is-the-runtimes-own-decision-replayed.md), [0090](adr/0090-one-dependency-graph-over-model-governance-and-consumers.md), [0093](adr/0093-change-impact-is-predicted-from-definitions-and-observed-on-decisions.md), [0094](adr/0094-links-across-systems-are-resolved-in-place-and-probed.md), [0095](adr/0095-a-read-returns-only-what-the-model-declares.md) | [`docs/reviews/5-0-pressure-test.md`](reviews/5-0-pressure-test.md), `packages/domain-hospital/test/explain-disclosure.test.ts` |

## Continuation state

- **Done:** slices 1 and 2 (one commit: they share the runtime's decision trace), 3, 4, 5, 6, 7, 8 and 9. Milestones A (exploration and explanation), B (context), C (impact) and D (evaluation) are complete, and the pressure test's findings are fixed except one in part (M2) and one kept (L3).
- **Open:** the subject's own decisions read to answer a workflow explanation are audited without `explainedBy` (M2).
- **What the evaluation says to do next:** dependents and change impact answer questions 4.0 could not, and are where further work pays. Context selection was no better than 4.0's on four requirements; improve it only against a harder benchmark with a tight budget.
