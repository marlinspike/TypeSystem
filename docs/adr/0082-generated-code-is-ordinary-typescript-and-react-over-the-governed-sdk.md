# 0082. Generated Code Is Ordinary TypeScript and React over the Governed SDK

## Status

Accepted (2026-10-16). Builds on ADR-0055 (SDK), ADR-0057 (workflows),
ADR-0058 (React bindings), ADR-0079 (the IR), ADR-0080 (the checker) and
ADR-0081 (lowering). Implemented in `packages/compiler/src/emit/`,
`packages/app` and `packages/ui`. Proven by
`packages/compiler/test/compile.test.ts` and `packages/app/test/expr.test.ts`.

## Context

A checked application (ADR-0080) has to become something that runs, that
a developer can read and extend in TypeScript, and that an architect can
put in front of executives. Two shortcuts were open and both were
refused. An interpreter that renders the IR at run time would hide the
behaviour from tsc, from code review and from the developer's own
extensions. A code generator that writes its own data layer, its own
workflow runner or its own authorization would be a second runtime beside
the one TypeSystem already has. The mandate asks for neither: TypeScript
stays first-class, and the runtime, query engine, workflow engine, SDK
and HTTP layer are reused.

## Decision

**Every primitive becomes a call of something that already exists.**

- *Reads* become typed SDK calls on the generated model (`client.from(T)
  .where((x) => x.f.eq(v))`, `client.get`, `client.related`,
  `client.aggregate`), so tsc checks each against the same model the
  checker did. A value a read takes from an expression is wrapped in
  `need(value, "$ref")`: a read never runs with a guess. In a flow an
  unknown value fails the step naming the reference; in the interface the
  data wait (`status: "waiting"`).
- *Expressions* become calls of `@typesys/app`'s `$` operators of the same
  name (`{ "gt": [a, b] }` is `$.gt(a, b)`), which implement the checker's
  three-valued semantics: unknown is `undefined`, a condition acts only
  when it is `true` (`$.holds`), division by zero and a sum over an unknown
  element are unknown, `where` drops elements whose predicate is unknown.
  Generated code therefore reads like the IR.
- *Flows* become `defineWorkflow` definitions (ADR-0081) registered with
  the existing `WorkflowEngine`, with an input interface and a step-output
  interface typed from the checker's types.
- *Nodes* become `@typesys/ui` components, and *effects* become calls of
  `useEffects`: `fx.invoke` previews the Action through the runtime and
  asks the person before it executes, `fx.run` starts a run as the
  person, `fx.set`, `fx.navigate` and `fx.refresh` do what they say.
- The *server* is `createAppServer` from `@typesys/app/server`: the
  existing `createApiApp` over the host's runtime, the existing workflow
  engine with the application's named models built through `@typesys/llm`
  (ADR-0074), and the existing `clientRouter` serving the client with
  deep links (ADR-0081).

**`@typesys/ui` is the composition layer, and it is headless where it
matters.** Behaviour comes from mature libraries (TanStack Table for
sorting, search, filters, grouping and paging; Recharts for charts;
d3-force and d3-geo with the offline us-atlas and world-atlas outlines for
graphs and maps) and from the existing `@typesys/react` (`Resource`,
`formFields`, `coerceForm`). Every data node sits in one `Frame` that
renders the data's state the same way everywhere: a skeleton while
loading, a waiting line while a value it needs is unknown, a refusal as a
refusal (an `ApiError` 401 or 403 is never shown as an empty table), a
withheld value as withheld rather than blank, and a banner for parts
whose source failed (ADR-0072). Nothing in the library injects a
`<style>` element, so the API's `style-src 'self'` policy holds: the
confirmation dialog is the native `<dialog>`, and tooltips are SVG
`<title>`s.

**Design is kept apart from behaviour.** Two design systems ship as CSS
custom properties on `[data-design]`: `meridian`, a dark operations
console, and `ledger`, a light editorial report. An application chooses
one, overrides any token (`--ts-accent`), and may replace any built-in
component by name through `design.system: "<module>#<export>"`, an
`Overrides` map in its own extensions. `useOverride` is the one extension
point every component goes through.

**Freshness without an event feed.** The API has no change stream, so the
interface publishes the Types an Action or run may have changed (an
Action's target and applicable Types; a flow's reads and writes) and
every read of one of them reads again. A datum may also poll with
`refresh.everyMs`, which pauses while the page is hidden.

**Handwritten code has a contract.** A `fn` call and a `custom` node are
typed by the checker; `src/generated/contracts.ts` declares each as a
TypeScript type, every argument possibly `undefined`, and
`contracts-check.ts` assigns each extension's export to its contract with
`satisfies`. An extension that drifts from the application is a compile
error at the contract check, not a wrong value at run time.

## Consequences

A compiled application is a directory a TypeScript developer recognises:
`server.ts`, `src/generated/`, `src/extensions/`, a `tsconfig.json`, and a
vitest suite. tsc checks all of it, generated and handwritten, against the
generated model, so a model change that breaks the application breaks the
build. The squadron fixture compiles, type-checks, bundles to a 238 KB
client, and passes its API and screen checks
(`packages/compiler/test/compile.test.ts`).

Limitations stated plainly: `$result` in a form's `then` effects is
untyped (`ResultValue`), because an Action's output schema and a run's
outputs are not narrowed by the checker yet; a node's `when` is
presentation, never a boundary, and the runtime still decides every value;
generated code is not run through a formatter, so its layout is the
emitter's own, deterministic but not Prettier's.
