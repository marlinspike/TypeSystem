# 0078. A Coding Agent Is Given the Model Its Caller May See

## Status

Accepted (2026-10-16). Builds on ADR-0056 (discovery), ADR-0068
(discovery authorization) and ADR-0075 (release to models). Implemented in
`packages/devkit/src/context.ts` (`compileContext`) and the
`typesys_compile_context` MCP tool in `packages/mcp-server/`. Used by
drafting (ADR-0077). Proven by `packages/mcp-server/test/context.test.ts`.

## Context

A coding agent writing code against TypeSystem needs to know the model:
which Types a task involves, their values and relationships, which
Actions change them and what they take. Giving it the whole model is
wasteful on a large deployment and wrong on a governed one, since the
model itself is subject to discovery rules (ADR-0068) and the values in it
to release rules (ADR-0075). What an agent is told, it repeats in the code
it writes and the answers it gives.

Separately, an agent writes worse code when it does not know which values
its caller is actually returned. Code that reads a value the caller never
receives compiles and fails at run time, or silently shows nothing.

## Decision

**One call, as the caller.** `compileContext(runtime, identity, { task,
focus?, maxTokens, probe, examples })` uses only what a caller's own
client could call: `describeModel`, `query` and `listActions`, each as
`identity`. So a Type the caller may not learn of is never in the
context, and an audience on the identity (a model reading for a person)
narrows it further, by the runtime's rules, not the compiler's.

**Relevant first, related next.** Types and Actions the caller names in
`focus` come first, then what the task's words find (the BM25 ranking of
ADR-0056), then the Types those relate to and the Actions on them. With
no match and no focus, every visible Type is a candidate.

**What the caller is returned, not only what the schema says.** For each
Type, up to `probe` objects are read as the caller. Values returned on
none of them are marked `[not returned to this caller]`; examples, when
asked for, are the values as the caller was returned them. For each
Action, `listActions` says whether the caller may invoke it on the Type,
and an instance-scoped Action is described as decided per object.

**A budget, kept.** The rendered text, headings and all, stays within
`maxTokens` (estimated at four characters a token). Items are dropped
least relevant first, and what was dropped is listed in the text and in
`omitted`, so the agent knows to ask for it with `focus`.

**Stable and checkable.** The result carries the rendered text, its
estimated tokens, the structured types and actions, and a sha256 digest
of the text: the same model, caller and task compile to the same context.

**Over MCP** it is `typesys_compile_context` (`task`, `focus?`,
`maxTokens` 500 to 32,000, `examples` 0 to 5), compiled for the
session's caller, read-only like the other built-in tools.

## Consequences

- An agent gets a few thousand tokens describing exactly what its task
  touches, as its caller sees it, instead of the whole model or nothing.
- The visibility probe is a sample: a value returned on none of three
  objects may be returned on a fourth. The text says "not returned to
  this caller" of what was observed, and the rules section tells the
  agent to treat every value as possibly absent.
- A computed value is described with what it depends on; whether it is
  returned is observed like any value, so a computed value may be
  returned while a value it depends on is not, as the runtime decides.
- Not addressed: compiling context for a set of callers at once, and
  incremental updates as the model changes.
