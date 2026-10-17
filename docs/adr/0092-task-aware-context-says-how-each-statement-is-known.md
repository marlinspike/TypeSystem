# 0092. Task-Aware Context Says How Each Statement Is Known

## Status

Accepted (2026-10-17). Extends ADR-0078 (`compileContext`). Builds on
ADR-0088 (inspection), ADR-0089 (explanations) and ADR-0090 (the
dependency graph). Implemented in `packages/devkit/src/context.ts`.
Exposed through `typesys_compile_context` (MCP) and `typesys app context`
(CLI). Proven by `packages/devkit/test/context-v2.test.ts`.

## Context

`compileContext` gives a coding agent the part of the model a task
needs, as the caller is told of it, within a token budget. It had three
weaknesses.

- **It ranked words, not dependencies.** It could keep an Action and drop
  the Type the Action acts on, which left the agent a contract it could
  not use.
- **It knew nothing of what is built on the model.** It did not list the
  workflows that start on a Type, the application pages that show it, or
  the acceptance checks that pin its behavior.
- **It did not say how it knew things.** "Not returned to this caller"
  came from reading a few objects, and was presented like the contract
  itself. An agent cannot weigh a statement whose source it is not told.

## Decision

**`compileContext` stays the one entry point.** Its `typesys.context/1`
fields are unchanged, so every existing caller keeps working. The new
fields are additions. `format` stays `typesys.context/1`, and a client
that does not read the additions loses nothing it had.

**Every statement carries a status.** Each one is marked:

- `verified`: the runtime decided it for this caller. This covers the
  model description, an Action's authorization from `listActions`, and a
  value's outcome on one probed object, found by explaining the caller's
  own read of it (ADR-0089).
- `inferred`: concluded from a sample. For example, a value absent from
  every probed object when no explanation was possible.
- `withheld`: the runtime decided the caller may not have it. The context
  says only what the caller's own explanation says, so a policy name
  appears only for an inspector.
- `unavailable`: the context could not say. The causes are a source that
  did not answer the probe, an item left out for the budget, or a
  consumer step that reads through code that declares nothing.

**Selection is dependency-complete.** An Action is kept only with the
Types it acts on and applies to, and, for an inspector, the Type it
returns (a description does not name it). Those Types are placed before
the Action, so the budget meets them first. If the budget forces one out,
the Action goes too. `omitted` still lists the names, and the new
`leftOut` gives each one's reason: `budget`, or `needs <Type>`. A
computed value's inputs are values of the same Type, so they are always
present with it.

**What is built on the model, from the graph.** The caller passes
`consumers` (`workflowUses`, `appUses`). Every workflow and application
part that uses a selected Type is then listed with how it uses it. The
acceptance checks among those parts are listed as the checks a change
must keep passing. They come from `governedGraph`, so an inspector's
context also names the sources, policies and markings that guard each
value. Anyone else's context says the governance is withheld from them,
and nothing more.

**How to query, and what to write.** For each Type the context says:

- which values a top-level sort and a search may name (stored ones);
- that a filter may name any value;
- the runtime's page limit;
- two lines of the typed SDK for reading it (`client.from(...)`,
  `client.get(...)`);
- for each Action, one line to preview it and one to invoke it.

The SDK lines are generated from the description, so they name only what
exists, and a `select` never names a value the caller is withheld. The
query rule and one example of each SDK call are the same for every Type,
so the text states them once, under RULES. Each Type's and Action's own
lines are in its `sdk` field.

**Marks are short.** A value with no mark was returned to the caller. The
others carry `[withheld: <control>]`, `[inferred: ...]` or
`[unavailable: ...]`. A status that applies to every value of a Type (the
read was refused, the source did not answer, there was nothing to probe)
is one line for the Type. A source's own error text is never repeated:
it can name hosts.

**The context names its model.** `modelDigest` is the inspection's digest
for an inspector, or the description's for anyone else. An agent can then
tell that the model changed under a context it holds.

## Consequences

- An agent's context for "add a page of aircraft that need attention" is
  the same text as before plus a few marked lines. It says `needsAttention`
  is verified readable for this caller and `maintenanceStatus` is verified
  withheld. It names the workflow and the check that use `Aircraft`, and
  gives the SDK call to read it.
- The context costs more tokens. The fleet readiness brief's context went
  from 1,209 to 1,453 tokens (20% more), most of it the marks, the
  model line, and the query and SDK rules. The engineer's recorded
  drafting of that brief was run again through `typesys engineer draft`
  with the coding agent's same two answers against the new request. It
  drafts the same mission with the same diagnostic, so the recording in
  `examples/missions/fleet-readiness-board/mission.draft.json` is keyed
  to the request as it is now.
- With consumers, each Type lists the applications and workflows that use
  it, one line per consumer naming its parts. The first version gave each
  part a line; the Milestone D evaluation measured that at 1.8 times the
  4.0 context and it was cut to 1.5 times
  ([semantic-workbench-2026-10-17.md](../evidence/semantic-workbench-2026-10-17.md)).
  The members each part uses, and checks reached only through another
  part, stay in the JSON.
- Probing explains one object per Type, which is one more governed and
  audited call per Type. `probe: 0` still reads nothing and claims
  nothing.
- The context is still a prediction made now. The runtime decides every
  call the agent's code makes, and the caveat says so.
