# 0080. The Checker Decides Before Any Code Exists

## Status

Accepted (2026-10-16). Builds on ADR-0057 (workflows), ADR-0068 (discovery
authorization), ADR-0071 (diagnostics) and ADR-0075 (release to models).
Implemented in `packages/compiler/src/check.ts`, `expr.ts`, `types.ts` and
`diagnostics.ts`. Proven by `packages/compiler/test/check.test.ts`, where
each seeded defect is caught at the JSON Pointer it lives at.

## Context

An application document (ADR-0079) is only useful if what is wrong with it
is found before it runs, and reported so a person or a coding agent can fix
it without reading compiler source. The runtime still enforces everything
(policy, release, validation); the checker exists so that enforcement is
rarely the first place a defect shows up.

## Decision

**One pass over the document, against the model as its author sees it.**
`checkApp(doc, env)` takes the parsed document and a `ModelDescription`
(`describeModel`, ADR-0056), plus optional hooks: what the model looks like
to each caller, whether a caller is admitted by a policy, what a model
audience may be released, and whether an extension module exists. It
returns diagnostics and an analysis (each data item's type and
dependencies, each flow's lowered steps, reads, writes and admitted
callers), which the code generator and impact analysis reuse.

**A small type lattice.** `Ty` is string (with enum and format), number
(with integer), boolean, null, list, object (with fields, the semantic Type
it came from and whether it is open) and unknown. JSON Schema becomes a
`Ty` with `schemaToTy`; reads get the row type the SDK returns (`$id`,
`$type`, `$unavailable`, and the selected values). `assignable` and `join`
decide every comparison, argument and input. Nothing is coerced: a string
compared with a number is `not-comparable`, and a literal outside an enum
is `not-in-enum`.

**Unknown is a value.** A value the caller may not be returned, or a step
a `when` may skip, is unknown, not null and not false. Expressions use
Kleene three-valued logic, so `and` with one false operand is false
whatever the other is, and `not` of unknown is unknown. The checker tracks
which values may be withheld or skipped, and reports `maybe-skipped` where
a step uses a possibly skipped step's output without a guard that implies
the same condition.

**Flows are checked as the engine will run them.** References are scoped:
a step reads `$input` and earlier steps only (`forward-reference`), a read
inside `parallel` cannot see its siblings, and an AI step may not take an
Action's output. Steps are lowered (ADR-0081) and the engine's own
`validateWorkflow` is run on a skeleton, so a workflow the engine would
refuse at registration is refused here, with the engine's code mapped to a
hint. An Action after an AI step without an approval between them is
`unreviewed-ai-output`; an Action that changes something and has no
compensation is a warning; `hoursSince`, the one clock operator, is
refused in flows (`nondeterministic-in-flow`) because compute steps are
replayed.

**Governance is checked per caller.** For each flow, each declared caller
is asked whether the start policy admits it. A flow nobody may start is
`no-caller-admitted`. An AI step whose model has no audience, or whose
input includes a value that audience may not be released, is reported
before a model ever sees it. A page node that invokes an Action with
`confirm: false` is `unconfirmed-effect`.

**Data in dependency order.** Page and application data form a graph;
a cycle is `cyclic-dependency` at the first item in it. Each read is
checked against the model (Types, values, relationships, operators, the
member names of `select`, `sort` and `include`), and the query is also run
through devkit's `validateQuery` with sample values substituted for its
expressions.

**Diagnostics an agent can act on.** Every diagnostic is an
`EngineerDiagnostic` (ADR-0071) with `code`, `at` (a JSON Pointer),
`message`, an optional `hint` naming the fix, and `because` when the cause
is somewhere else. `DIAGNOSTIC_CODES` gives each code a meaning and a
resolution, served by `typesys app explain <code>`.

## Consequences

- The checker is pure and fast: no source is called and no code is
  generated, so an agent can run it after every edit.
- Runtime enforcement is unchanged. A check passing here never grants
  anything; a caller refused by policy at run time is still refused.
- The checker's notion of "the caller may see" comes from the hooks it is
  given. Without them, per-caller checks are skipped and a flow's admitted
  callers are left undefined in the analysis, rather than assumed.
