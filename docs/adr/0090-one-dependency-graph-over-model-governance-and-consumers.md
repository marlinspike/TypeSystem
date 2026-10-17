# 0090. One Dependency Graph over the Model, Its Governance and What Is Built on It

## Status

Accepted (2026-10-17). Builds on ADR-0088 (inspection), ADR-0052
(derivations and releases), ADR-0057 (workflows), ADR-0079 (the
application IR) and ADR-0068 (discovery). Implemented in
`packages/devkit/src/graph.ts` (`semanticGraph`, `dependents`,
`dependencies`, `neighborhood`, `overview`),
`packages/workflow/src/uses.ts` (`workflowUses`) and
`packages/compiler/src/uses.ts` (`appUses`). Proven by
`packages/devkit/test/graph.test.ts`, `packages/compiler/test/uses.test.ts`
and the declared-reads cases in `packages/workflow/test/explain.test.ts`.

## Context

Three diffs each know one layer. `diffModels` knows Types and Actions,
`diffApps` knows pages, flows and checks, and workflows reference Actions
and policies in TypeScript. Nothing joins an application's acceptance
check to the member, source and policy it rests on. "What depends on
`maintenanceStatus`?" has no answer short of reading every consumer.

A workflow read step is an opaque function over the typed client. The
graph cannot see what it reads, and a guess would be wrong in both
directions.

## Decision

**One graph, built from what its builder may learn.**
`semanticGraph(model, consumers)` takes either an inspection (ADR-0088) or
a description. An inspection gives the enforcement structure: sources,
policies with their rules, and markings. A description gives the contract
only, and the graph says so (`structure: "description"`). Nothing the
builder may not learn of appears. A consumer's use of something the model
does not describe becomes an `unresolved` node, and the graph does not say
whether that thing is missing or withheld.

**Every edge reads "depends on".** The edge kinds are:

- `derives-from` and `released-from` (computed values)
- `reads-from` (a stored value, a relationship or a declared computation
  reads a source)
- `writes-to` (an Action's effect lands in a source)
- `guarded-by` (a policy) and `marked` (a marking)
- `targets`, `applies-to` and `returns`
- `uses` (a consumer's part)

Containment (a member in its Type, a step in its workflow, a flow in its
application) is the node's `parent`, kept separate from dependency.
Each edge is `declared`, meaning stated by a definition or a consumer's
own specification, or `inferred`.

**Consumers are data.** A `GraphConsumer` is a workflow or an application
whose parts each list what they use. `workflowUses(definition)` and
`appUses(spec, model?)` produce them, so devkit depends on neither
package. `appUses` reads member-level uses from a read's `select`,
`filter`, `sort` and `include`, from the fields each component shows, and
from the members an acceptance check names. A read with no `select` uses
its whole Type.

**A whole-Type use depends on every member, and only the members.** A
query without `select`, an object read and a relationship's objects
depend on each member of the Type they read. They do not depend on the
relationships that Type could go on to follow. Without this rule every
dependency walk would cover the whole connected model.

**Read steps may declare their reads, and the engine holds them to it.**
`ReadStep.reads` names the Types a step reads, including every Type it
follows a relationship to. With a declaration, the read-only transport
refuses a read of any other Type, and following a relationship (`related`,
or a query's `include`) to one; the definition check refuses an unknown
one. A part that reads two whole Types is related, by an inferred edge, to
each relationship between them, so a change to the relationship or to
the target's values reaches it. A step without one is shown as `opaque`. Nothing is guessed for it,
and a dependency walk that reaches it says so.

**Queries for a workbench, not a query language.**

- `dependents` and `dependencies` walk against or along the edges from a
  node and everything it contains. Each node reached comes with its path,
  distance, the edge that reached it and whether any edge on the way was
  inferred. The walk also returns the workflows and applications those
  nodes belong to.
- `neighborhood` returns the nodes within a few hops, nearest first, up to
  a limit, with the nodes that have more to expand.
- `overview` folds members into their Types and parts into their
  consumers, so a large model opens as a map of Types, sources, policies
  and consumers.

## Consequences

- Impact analysis (ADR-0093), task-aware context (ADR-0092) and the
  workbench (ADR-0091) share one account of dependency instead of three.
- The graph is deterministic. `digest` is the sha256 of its nodes and
  edges, so two graphs of one model and one set of consumers are equal by
  digest.
- A workflow written before this ADR keeps working. Its read steps show as
  opaque until they declare `reads`. `airforce.GroundForRepair` declares
  them now.
- The graph says what a definition depends on. It never says what any
  caller may read: the runtime decides that, and explanations
  (ADR-0089) say why.
- An application's flows are compiled from the IR, so `appUses` reads
  their steps from the IR directly. The generated code is unchanged.

## Amendment (5.0 pressure test, 2026-10-17)

`GroundForRepair`'s `history` step followed `maintenance` to
MaintenanceEvent while declaring only Aircraft, so a change to a
maintenance event's values reached nothing. Read steps now declare the
Types they follow relationships to, as above, and the step declares both.
An edge whose end the model does not describe, such as a computation's
input the caller is not told of, is left out of the graph; before, the
overview and dependency views crashed on it.
