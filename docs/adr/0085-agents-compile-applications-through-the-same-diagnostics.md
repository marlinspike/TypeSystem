# 0085. Agents Compile Applications Through the Same Diagnostics, Diff and Context

## Status

Accepted (2026-10-17). Builds on ADR-0071 (the engineering loop's tools),
ADR-0078 (the context compiler) and ADR-0079 to ADR-0084. Implemented in
`packages/compiler/src/cli.ts`, `src/mcp.ts` and `src/diff.ts`, and
delegated from `typesys app`. Proven by `packages/compiler/test/agent.test.ts`.

## Context

The mandate asks that agents can discover the language, validate,
compile, read structured diagnostics, recompile, run acceptance tests and
extend in TypeScript, using the context compiler, the engineering loop
and MCP. An agent that has to read the compiler's source to learn the IR,
or parse prose errors, or diff generated files to learn what a change
did, spends its budget on the wrong thing.

## Decision

**One command surface, two transports.** `typesys app` (in
`@typesys/compiler`, delegated from `@typesys/cli` like `engineer` and
`onboard`) has `catalog`, `explain`, `context`, `check`, `compile`,
`build`, `verify` and `diff`, each with `--json`. `typesys-app-mcp [root]`
exposes the same eight as `typesys_app_*` tools by calling the CLI's own
code, so the two cannot disagree. Every path a tool takes must be inside
its root, and a host module given as a path must be too.

**The language is data.** `catalog` returns every node, step, effect,
operator and reference scope with its fields, from the same table the
parser validates against (ADR-0079). `explain <code>` returns what each
diagnostic code means and how to resolve it.

**Context comes from the context compiler.** `context <dir> --as
<caller>` compiles the model context for the application's own
requirement, as that caller is told of the model and returned values
(ADR-0078), so the agent writes the specification against what the
runtime will actually show the person it is for.

**The diff is semantic.** `diffApps(before, after)` compares two
specifications in the IR's own terms: pages by name, nodes by stable id
(with a separate change for the arrangement and the nodes without one),
flows by key, steps by name, data, state, models, callers and acceptance
checks by id. Each change carries the fields that differ and, where it
can break something that worked, a `risk`: a page whose path changed
breaks links; a removed node breaks a screen check that names it; a flow
whose steps or input changed while its version did not makes runs in
flight resume on new steps. The impact lists the Types and Actions the
changed parts read and invoke, and the acceptance checks that exercise a
changed page, flow, caller, Type or Action: the ones to run first. With a
host, `typesys app diff` checks and generates both versions against the
same model and lists exactly the generated files whose content differs.

## Consequences

The loop an agent runs is: `catalog` once, `context` for the
requirement, write `app.json`, `check` until no error, `compile`,
implement any `src/extensions/` stubs against their generated contracts,
`verify` until ok; after a change, `diff` says what it reaches before
`verify` confirms it. Every step answers with `{code, severity, at,
message, hint, because}` at a JSON Pointer into `app.json` or a
`file:line:col`.

A semantic diff of the model itself (a Type or Action that changed under
an application) is still `typesys diff` on two model descriptions
(ADR-0056); `typesys app check` against the new model is what says which
parts of the application it breaks.
