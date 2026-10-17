# 0079. An Application Is Compiled from a Typed IR of Five Primitives

## Status

Accepted (2026-10-16). Builds on ADR-0053 (Actions), ADR-0055 (SDK),
ADR-0057 (workflows), ADR-0063 (missions), ADR-0071 (engineering loop)
and ADR-0074/0075 (models and release). Implemented in
`packages/compiler/src/ir.ts`, `parse.ts` and `catalog.ts`. Proven by
`packages/compiler/test/check.test.ts`.

## Context

A mission (ADR-0063) describes a capability: some Types, a workflow, the
checks that prove it. It does not describe an application. Everything a
person sees and does (pages, tables, forms, approval queues, the state a
selection carries from one component to the next) is written by hand, and
so is every branch, retry and compensation inside a workflow. An agent
asked for "an excursion response console" therefore writes most of the
code with no help from TypeSystem in deciding whether it is right: a
misspelt field, a step that reads another before it runs, a form that
starts a workflow nobody may start, or an AI step handed a value its
audience may not see are all found at run time, if at all.

The opposite mistake is a new general-purpose language. It would need its
own tooling, its own debugger and its own escape hatches, and every
TypeScript developer and coding agent would have to learn it.

## Decision

**An application is one JSON document, `typesys.app/1`, made of five
primitives.** Anything they cannot say is a TypeScript function in
`src/extensions/`, called from the document by name with a declared result
schema.

1. **Reads** are the runtime's own queries: `query` (a `SemanticQuery`),
   `object`, `related` and `aggregate` (a `SemanticAggregateQuery`), with
   expressions allowed wherever the runtime takes a value. There is no
   second query language.
2. **Expressions** are one-key operator objects (`{"eq": [a, b]}`), scope
   references (`"$input.aircraftId"`, `"$row.$id"`), `{"literal": ...}`
   and `{"fn": "module#export", "args": [...], "returns": schema}`. The
   operator set is closed and listed in `OP_CATALOG`. There are no
   variables, no assignment, no loops and no user-defined operators.
3. **Steps** make a flow: `read`, `compute`, `check`, `ai`, `approval`,
   `action`, `parallel` (reads only) and `forEach` (reads only, with a
   required `max`). Each takes an optional `when` and `retry`. A flow is a
   workflow (ADR-0057) by another notation: it has the same name, version,
   start and cancel policies and input schema, and it becomes one.
4. **Nodes** compose a page: layout (`grid`, `stack`, `tabs`, `section`,
   `text`), data views (`metric`, `chart`, `table`, `detail`, `timeline`,
   `graph`, `map`, `provenance`), interaction (`form`, `actions`,
   `approvals`, `run`, `assistant`) and `custom`, a handwritten React
   component with a declared props contract.
5. **Effects** are what an interaction does: `set` page state, `run` a
   flow, `invoke` an Action (previewed and confirmed by default),
   `navigate` and `refresh`.

Application-level `state`, `data`, `flows`, `pages`, `models`, `callers`
and `acceptance` tie these together. Every name has one form (camelCase
for data, state and flows; PascalCase for pages; qualified for workflows;
kebab-case for node ids), and every key is checked: an unknown key is an
error with the name the author probably meant.

**Acceptance belongs to the application.** The existing engineering-loop
checks (ADR-0071: `reads`, `refused`, `starts`, `approves`, ...) are
accepted unchanged, and a `screen` check says what a caller sees on a page
in a browser: which nodes are visible, which are refused, how many rows a
table shows.

**The catalog is data.** `NODE_CATALOG`, `STEP_CATALOG`, `EFFECT_CATALOG`
and `OP_CATALOG` describe every property: its kind, whether it is
required, and what it means. The parser, the checker, `typesys app
catalog` and the agent tools all read the same tables, so documentation
and validation cannot drift apart.

**Versioned and extensible.** The format string is checked first, so
`typesys.app/2` can change anything. Within `/1`, a new node, step,
effect or operator is an addition to a catalog table and to the checker,
and an older document is still valid.

## Consequences

- TypeScript stays first-class. A rule the operators cannot state is a
  typed function (ADR-0080 checks its declared result), and a component
  the catalog lacks is a typed React component.
- The document is small enough for a coding agent to write and for the
  compiler to explain line by line. Every diagnostic carries a JSON
  Pointer into it.
- Things the primitives cannot express are refused, not approximated. An
  Action inside `forEach` or `parallel` is refused (start one run per
  object instead), and so is unbounded iteration. Event subscriptions
  are not a primitive: data refreshes on a declared interval and after
  the application's own Actions and runs (ADR-0082).
