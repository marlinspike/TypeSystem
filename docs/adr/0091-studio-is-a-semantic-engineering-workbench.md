# 0091. Studio Is a Semantic Engineering Workbench

## Status

Accepted (2026-10-17). Builds on ADR-0061 (Studio), ADR-0058 (the governed
API), ADR-0088 (inspection), ADR-0089 (explanations) and ADR-0090 (the
dependency graph). Implemented in `packages/studio/src/client/`
(`GraphView`, `InspectorPanel`, `ExplainView`), the `/inspection`,
`/subjects`, `/explain`, `/workflows/:name/explain` and `/graph` routes of
`@typesys/http`, the `typesys_inspect`, `typesys_explain` and
`typesys_graph` MCP tools, and `typesys app inspect | why | graph`. Proven
by `packages/studio/test/workbench.test.ts` (Chromium),
`packages/http/test/workbench.test.ts`,
`packages/mcp-server/test/workbench-tools.test.ts` and the CLI cases in
`packages/compiler/test/uses.test.ts`.

## Context

Studio listed Types, ran queries and previewed Actions. A developer could
not see how the model composes, where a value comes from, what guards it,
what depends on it, or why a caller sees what they see. The questions are
the same in a browser, from an agent and at a terminal. Answering them
three ways would give three answers.

TypeSystem is not a low-code platform, a visual application designer or a
frontend IDE. The workbench explores and explains. It does not author.

## Decision

**Studio is a workbench, narrow by design.** It gains two tabs:

- **Graph.** The dependency graph opens progressively. The overview shows
  Types, Actions, sources, policies, markings, workflows and
  applications, with members and parts folded in. Opening a node shows
  its neighborhood, up to 80 nodes within one to three hops. Finding a
  node by name searches the whole graph. A dependency walk ("what depends
  on it", "what it rests on") is drawn on its own, with the subject in
  the middle and each ring one hop further out. The panel shows the
  selected Type's or value's sources, policies with their rules, markings
  and derivations, from the inspection.
- **Explain.** Any of the four explanation questions, or a workflow, for
  the signed-in caller. For an inspector, it can also explain for any
  subject in the deployment's directory. The answer shows each finding
  with its outcome, how it is known, the control and policy that decided
  it, the reason, and what would change it.

Nothing in it edits the model, a policy or an application.

**One library, chosen for the shape of the data.** The graph is drawn
with Cytoscape.js. It is mature, MIT-licensed, renders thousands of
elements on a canvas, and ships concentric, breadthfirst and
force-directed layouts. It is a development dependency of the Studio
client only, bundled into `studio.js`, and nothing else loads it.
Containment is drawn as a dotted edge rather than as nested boxes, which
keeps every layout readable. Cytoscape injects one inline stylesheet,
which the client's Content Security Policy refuses. Instead the page's
own stylesheet link carries the id Cytoscape looks for, and `studio.css`
holds its one rule. The CSP is unchanged.

**Every surface asks the same functions.**

- `governedGraph(runtime, identity, consumers)` builds the graph.
- `queryGraph(graph, request)` answers a view.

HTTP, MCP and the CLI each call those two functions and add only
argument checking. Each host also calls `runtime.inspectModel` and
`runtime.explain` directly, so the runtime decides every answer for the
caller.

**Explaining someone else needs a directory, and is gated first.** A host
names its subjects with `subjects: { list, resolve }`. A caller who may
not inspect is refused before the directory is asked. That way a refusal
never says whether a subject exists. A host without a directory explains
only the caller's own access.

**Graph views follow the caller's discovery.** An inspector gets the
graph from an inspection. Anyone else gets it from their description,
without sources, policies or markings, and without the policies their
consumers name. Under need-to-know discovery, anything a consumer names
that the caller's description leaves out is dropped.

**Demonstration hosts name an inspection policy.** The policies are
`airforce.inspect` (the lead) and `coldchain.inspect` (quality assurance
and the auditor). `buildAirforceWorkbench` and `buildColdChainHost`
configure them. `npm run studio` signs in as the lead, the maintainer or
the viewer, and registers `GroundForRepair`.

## Consequences

- A developer sees, in one place, that `maintenanceStatus` comes from the
  in-memory repository under `airforce.maintainer-only`. They also see
  that `readinessStatus` and `needsAttention` derive from it, and that it
  reaches the squadron application's board, its acceptance checks and every
  workflow step that reads an Aircraft. One click away is why the viewer does not see it.
- An agent asks the same questions with `typesys_inspect`,
  `typesys_explain` and `typesys_graph`, and gets the same answers.
- The layouts are deterministic. The concentric layout places nodes by
  ring, and the graph is sorted. Screenshots therefore change only when
  the model does.
- The overview is still dense for a model of hundreds of Types. Its kind
  filters and node search are the intended way in, and the neighborhood
  and walk views stay small whatever the model's size.
