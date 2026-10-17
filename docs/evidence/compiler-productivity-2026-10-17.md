# The application compiler measured against the engineering loop, 2026-10-17

This page compares the 4.0 application compiler (`typesys app`,
ADR-0079 to ADR-0087) with the 3.0 engineering loop (`typesys engineer`,
ADR-0071) on the same mission, and then the compiler alone on Cold Chain
Command. No model API was called.

Every figure below was **measured** by
[`scripts/measure-compiler.ts`](../../scripts/measure-compiler.ts), which
writes [`compiler-productivity/results.json`](compiler-productivity/results.json),
unless it is marked otherwise. The run was on commit `b3ed48f` with Node
22.22, in the cloud container this work ran in, which has a shared CPU.
Timings are therefore indicative, not benchmarks. To reproduce:

```sh
npm run build
npx tsx scripts/measure-compiler.ts
```

## The same mission, two ways

The input is `examples/missions/sortie-readiness`, the 3.0 mission over
three independent services. The engineering loop scaffolds and verifies
it as it is. The compiler takes the same mission translated by
`typesys app migrate` (ADR-0086), with no edits.

| | Engineering loop (mission) | Compiler (app) |
|---|---|---|
| Spec: JSON values | 171 | 206 |
| Spec: bytes | 4,677 | 5,432 |
| Generated files | 7 | 9 |
| Generated code, non-whitespace characters | 9,559 | 10,102 |
| Handwritten code | none | none |
| Acceptance checks passed | 15 of 15 | 15 of 15 |
| Scaffold or compile | 360 ms | 172 to 217 ms (3 runs) |
| Build (tsc and esbuild) | in verify | 360 to 410 ms (3 runs) |
| Verify, end to end | 3,874 ms | 4,235 ms |

The app spec is larger because the migration adds a form to start the
workflow and an approval queue, which the mission's API-only workflow
did not have. Line counts are not compared, because the two generators
format differently. Characters and JSON values are compared instead.

Both pipelines reach the same 15 checks with no handwritten code, so on
this mission the compiler is neither smaller nor faster to write. Its
differences show up in what happens on the way there, and in what it can
express that a mission cannot.

## Ten seeded defects

Each defect is one an author, whether a person or a model, plausibly
writes. It was seeded once in each spec at the equivalent place. The
table records the first stage that reported it, and where the report
pointed.

| Defect | Engineering loop | Compiler |
|---|---|---|
| A read names a Type that does not exist | plan, `unknown-type` at `workflow/steps/0` | check, `unknown-type` at `/flows/confirmSortie/steps/0/read/type` |
| A check compares a field that does not exist | plan, `unknown-field` at `workflow/steps/2` | check, `unknown-field` at `…/steps/2/assert/eq/0` |
| A check compares a string with a number | **acceptance**, after 4.2 s, at `acceptance/10` | **check**, `not-comparable`, in 169 ms, at `…/steps/2/assert/eq` |
| A check compares a value the initiator is never returned | acceptance, at `acceptance/10` | acceptance, at `acceptance/10` |
| The approval names a policy that does not exist | acceptance, at `acceptance/13` | acceptance; the checker **warned** first: `no-caller-admitted` at `…/steps/3/policy` |
| The start policy does not exist | acceptance, at `acceptance/10` | acceptance; the checker **warned** first: `no-caller-admitted` at `…/startPolicy` |
| A table shows a field that does not exist | plan, `unknown-field` at `views/0` | check, `unknown-field` at `/pages/0/data/fleetBoard/query/select/3` |
| The approval presents a step that does not exist | plan, `invalid-mission` at `workflow/steps/3` | check, `unknown-reference` at `…/steps/3/present/1` |
| The approval admits the requester | acceptance, at `acceptance/14` | acceptance, at `acceptance/14` |
| An acceptance check names a step that does not exist | acceptance, at `acceptance/10` | acceptance, at `acceptance/10` |

The compiler reported 5 of the 10 before any code existed, each in under
200 ms and at the exact JSON pointer. The engineering loop's planner
reported 4 of them at plan time, pointing at the step or view rather than
the field. The compiler adds the type mismatch: the loop found it only
when an acceptance check failed after a full build and a run of the
services, and named the check that failed, not the step at fault.

For 2 more defects, the misspelt policies, the compiler warned before
anything ran and named the policy. Neither pipeline stops on those before
acceptance, because a policy that admits nobody is legal.

The other 3 are found by the acceptance checks in both pipelines: the
withheld value, the self-approval and the misnamed step in a check. The
first two are policy facts that only the runtime decides as each caller.
The third is a mistake in the check itself. So the compiler does not
replace acceptance checks; it moves type and reference errors in front
of them.

## Regenerating after a change

The same one-word change was made to a table's title in each spec, after
a hand edit to the generated file that shows it.

| | Engineering loop | Compiler |
|---|---|---|
| Files the change rewrote | `views.tsx` | `src/generated/pages/FleetBoard.tsx` |
| The hand edit | overwritten without notice | refused: `edited-generated-file` at `src/generated/pages/FleetBoard.tsx` |

Both regenerate only the file the change reaches. The compiler also
protects work done in the wrong place, and since the pressure test it
does so even when the lock file is missing (P4-03).

## The reference application, which a mission cannot express

Cold Chain Command (ADR-0087) runs over three services TypeSystem did not
write. It is compiled from one `app.json` and four handwritten
extensions.

| | |
|---|---|
| Spec | 831 JSON values, 20,660 bytes |
| Generated code | 13 files, 36,838 non-whitespace characters |
| Handwritten code | 4 files, 87 lines, 3,963 non-whitespace characters (the stability rule, the value-at-risk rule, the gauge component and the stand-in model) |
| Share of the application's code written by hand | 9.7% of characters |
| Acceptance checks | 18 of 18 (14 API, 4 in Chromium) |
| Verify, end to end | 8,166 ms |
| Client bundle | 970,031 bytes minified; 299,249 bytes gzipped (measured with `gzip -c`, outside the script). It includes React, TanStack Table, d3 and two offline atlases. |
| Step kinds used | read, parallel, compute, ai, check, approval, action. A mission has no parallel, compute or ai step. |
| Interface node kinds used | 17. A mission has only tables, so 16 of the 17 have no mission equivalent. |
| Existing packages the generated code runs on | `@typesys/app`, `@typesys/ui`, `@typesys/workflow`, the host package `@typesys/cold-chain`, and `@typesys/compiler` (its acceptance tests only) |

The comparison with the engineering loop stops here, because the loop
cannot build this application. It has no AI step, no computed values, no
parallel reads and no interface beyond tables.

## What building it took, in this session

These figures come from this session's own transcript. Each count is the
coding agent's tool calls between one slice's commit and the next.

| Slice | Tool calls |
|---|---|
| 1, the IR and checker | 129 |
| 2, compilation, UI, build and verify | 182 |
| 3, the agent surface | 33 |
| 4, migration | 39 |
| 5, Cold Chain Command (three services, the governed model, the app and its browser test) | 116 |

There were no human interventions after the mandate: the owner sent no
messages during the work. Writing slice 5 surfaced 6 defects: 2 in the
compiler and 4 in the layers below it (the HTTP adapter could not
aggregate, and three UI defects). The measurement run surfaced a seventh,
in the HTTP layer: deep links returned 404 when an app lives under a
folder whose name starts with a dot. All seven are fixed with tests.

This is one agent building one application, n = 1. These are not
comparable productivity figures. The agent also wrote the compiler it was
using, so it knew the IR better than a newcomer would. There is no
measured figure for a person, or for an agent starting cold, building the
same application by hand or with the 3.0 loop.

## Against the mandate's dimensions

| Dimension | What was measured | What was not |
|---|---|---|
| Lines of code | Generated and handwritten code, in characters and JSON values, above | Lines written by a person |
| Interventions | None after the mandate (n = 1) | Any comparison |
| Tool calls | Per slice, above (n = 1) | The same application by another route |
| Defects | Ten seeded defects, and the stage that reports each one | Defect rates in real use |
| Correctness | Every acceptance check, API and browser, on both apps | Anything outside the checks |
| Reuse | The existing packages the generated code runs on; nothing reimplemented | |
| Regeneration | Files a change rewrites, and hand-edit protection | Long-lived drift |
| Maintainability | Hand edits refused; extension contracts checked by tsc (`compile.test.ts`) | A maintainer's effort over time |
| Performance | Compile, build and verify times on a shared CPU; bundle size | Load, latency under traffic |

## Not measured, and why

**A model drafting an application.** That needs paid model runs, which
this project does not make. The 3.0 measurement of agent-mode drafting is
the nearest evidence, and it is an upper bound
([`llm-drafting-2026-10-16.md`](llm-drafting-2026-10-16.md)).

**A person building the same application conventionally.** The
evaluation's conventional arm (ADR-0073) needs a person and has not been
run.
