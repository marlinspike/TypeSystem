# Independent adversarial review of M4: the engineering loop (ADR-0071)

Reviewed: PR #14, branch `claude/typesystem-3-hardening-3mkmfl` at `0907181`
("M4: the engineering loop"). Scope: `packages/engineer` (mission, plan,
scaffold, verify, CLI, MCP tools), the `typesys engineer` delegation in
`packages/cli/src/bin.ts`, `examples/missions/component-replacement`,
`.claude/skills/typesys-engineer` and ADR-0071. Date: 2026-10-14.

Reproductions live in two test files on branch
`claude/m4-adversarial-review-clml52`:

- `packages/engineer/test/m4-adv-fast.test.ts` (fake applications, plan,
  scaffold and the MCP root; about 2 s).
- `packages/engineer/test/m4-adv-verify.test.ts` (scaffold and verify the
  real application; about 4 s).

Each test states the behaviour the ADR or the skill promises and **fails on
0907181**. 19 tests fail and 1 records an attack that held. The existing 10
engineer tests still pass, `npm run typecheck`, lint on the new files and
`npm run check:terminology` are clean.

```
npx tsc -b --force && npx vitest run packages/engineer
Test Files  2 failed | 3 passed (5)
     Tests  19 failed | 11 passed (30)
```

## Summary

The loop's central promise is that `verify` reports `ok` only when the
application does what the requirement says for each person. It does not
hold in four ways, each reproduced against the shipped example. Negative
checks are decided by "did the request fail" rather than "did the runtime
refuse", so an application that serves nothing passes them. `verify` runs
whatever `dist/` holds, and the application's own `tsconfig.json` decides
whether the source is ever compiled into it. A one-character typo in an
`approves` check silences the self-approval defect the ADR uses as its
demonstration. Finally, the check step the scaffold generates passes when
both values it compares are withheld from the run's initiator.

The MCP root is confined lexically only, so symlinks and the application's
`tsconfig.json` write outside it. Several spec fields reach generated
TypeScript unescaped and run when the server loads.

| # | Severity | Finding | Test |
|---|---|---|---|
| H1 | High | Negative checks pass when the API fails for any reason | F1 |
| H2 | High | `verify` runs a stale build: the app's tsconfig decides whether source is emitted | V1 |
| H3 | High | `approves … admitted:false` passes on any non-200; plan never checks `step` | V2, F3 |
| H4 | High | Generated check step passes when both sides are withheld (`undefined === undefined`) | V3 |
| M1 | Medium | MCP root is lexical: symlinks and tsconfig `outDir` write outside it; a symlinked mission leaks a prefix | F9, F10, F12 |
| M2 | Medium | Spec strings become code: `deadlineMs`, view `limit`, view `name`, workflow input names | F8 |
| M3 | Medium | Checks share one server's state, so a verdict depends on its position, and the hint blames the caller | V4 |
| M4 | Medium | `reads` with only `withheld`, `query` with only `atMost` (or with neither) pass on an empty 200 | F2 |
| M5 | Medium | `refused` on an object that does not exist passes for every caller; plan does not check it exists | F5 |
| L1 | Low | A check with no `as` is accepted and runs as the anonymous caller | F4 |
| L2 | Low | `$step.a.b` is silently cut to `$step.a` in validation, plan and generated code | F6 |
| L3 | Low | A caller the spec names but no check covers is not reported | F7 |
| L4 | Low | An unresolvable host module rejects `verifyMission` instead of a diagnostic at `host/module` | F14 |
| L5 | Low | `host.module` may be an absolute path outside the MCP root, and runs during `plan` | F11 |
| L6 | Low | `insideRoot` refuses a name inside the root that starts with `..` (`..cache/`) | F13 |
| L7 | Low | Diagnostics that point away from the cause (several, from code reading) | none |
| L8 | Low | Scaffold writes files the plan does not list, and `build` never cleans `dist/` | none |

## High

### H1. Negative checks pass when the API fails for any reason

`runCheck` decides every negative check by the request failing, not by the
runtime refusing:

- `refused` passes on any 403 or 404 (`verify.ts:59`, `:91`). A missing
  route, a misspelled Type in the URL, or an object that does not exist all
  give 404.
- `offered: false` treats any non-200 as an empty list (`verify.ts:103`).
- `described: false` passes on any non-200 (`verify.ts:111`).
- `starts` with `status: "refused"` passes on a 404 (`verify.ts:118`), which
  is also what an unregistered workflow returns.

F1 points the example's three negative checks and a `described:false` check
at an HTTP server that answers 404 to everything. **All four pass.**

This matters because the skill tells agents to encode precisely the
requirement's "only", "not", "other than" and "cannot" as these checks
(`.claude/skills/typesys-engineer/SKILL.md`, step 1). Those are the
sentences the loop exists to protect, and they are the ones that pass when
the application is broken. In the example a positive check usually fails
alongside, but nothing requires a spec to have one, and a regression that
breaks only one route (say the actions listing) leaves its negative check
green.

Fix: a negative verdict needs a positive signal from the runtime. For
`offered`, require the 200 listing and look for the Action with
`authorized: false`. For `described`, require a 200 model or an
authorization problem, not any status. For `refused` and `starts`, accept
only the problem types the HTTP layer emits for authorization (403, or the
404 it emits for an unreadable object). Treat any other status, including a
route 404, as `check-failed` with "the API did not answer".

### H2. `verify` runs a stale build

`build` runs `tsc -p <dir>` with the directory's own `tsconfig.json`
(`verify.ts:158`). `startApplication` then runs `dist/server.js` if it
exists (`verify.ts:183-185`). Nothing ties the `dist/` that runs to the
source in the directory, and nothing checks the tsconfig is the one the
scaffold wrote.

V1 scaffolds the example and verifies it (`ok`). It then seeds the loop
test's own defect (`allowSelfApproval: true` in `workflow.ts`) and adds
`"noEmit": true` to the tsconfig. `verify` typechecks the defective source,
runs the previous build, and reports **`ok: true`**. The same follows from
narrowing `include`/`files`, or moving `outDir`. These are edits an agent
makes while fighting a compile error, and the skill's "never change a
check" rule does not cover them.

ADR-0071 also says the build is "strict, `noUncheckedIndexedAccess`", but
those come from the same editable file.

Fix: build with compiler options `verify` owns. Pass `--outDir` and the
required strictness flags on the command line, or use a tsconfig `verify`
writes and extends. Delete `dist/` before building, and fail with a
`build-error` if `dist/server.js` is missing or older than the build start.

### H3. `approves … admitted: false` passes on any non-200, and plan never checks `step`

`admitted` is `a.status === 200` (`verify.ts:130`). A 409 (the run is not
waiting on that step) and a 404 count as "not admitted". `plan` never checks
that an `approves` check's `step` names an approval step of the workflow.

V2 renames `step` in `lead-cannot-approve-own-request` to `leadAproval`.
Plan accepts it, and the check passes with `observed: { admitted: false }`
because the approval answered 409. Seeding `allowSelfApproval: true`, the
defect ADR-0071 uses as its proof, then gives **`ok: true`**. F3 shows plan
reports nothing for the typo.

The same mechanism means an application that drops the approval step
altogether passes every `admitted:false` check. In the example
`maintainer-requests-replacement` (`waitingOn`) catches that, but only
because the spec happens to include it.

Fix: in plan, `unknown-step` when `step` is not an approval of the
mission's workflow (with `didYouMean`). In `runCheck`, start the run, require
that it is `waiting-approval` on `step` before approving, and count only an
authorization refusal as "not admitted". Record the status in `observed`.

### H4. The generated check step passes when both sides are withheld

`stepSource` emits `JSON.stringify(a) !== JSON.stringify(b)`
(`scaffold.ts:100`). Read steps run as the initiator, so a field withheld
from the initiator is `undefined`, and `JSON.stringify(undefined) ===
JSON.stringify(undefined)`. The guard passes without having compared
anything, and the run goes on to its approval and Actions.

V3 builds a two-step workflow (start policy `airforce.read-aircraft`) that
reads AF86-0147 ("FOB ALPHA") and AF86-0212 ("Home station") and checks that
their `deploymentLocation` is equal. As the maintainer the run is `failed`,
as it should be. As the viewer, who may read neither SECRET value, every
step completes and the run is **`completed`**. `verify` catches it only
because V3's spec has a check for that caller.

Fix: in the generated step, fail when either side is `undefined` ("the
initiator may not read X"). In plan, warn when a check step compares a field
some caller admitted by `startPolicy` is not told of.

## Medium

### M1. The MCP root is confined lexically only

`insideRoot` is `path.resolve` plus `path.relative` (`mcp.ts:350-356`). It
never calls `realpath`, and `verify` lets the application's tsconfig choose
where `tsc` writes. ADR-0071 says "every path it is given must resolve
inside the root".

- F9: `out` is a symlink inside the root that points outside it. `scaffold`
  returns `ok: true` and writes all 8 files outside the root. `writeFile`
  also follows a symlinked `server.ts` already inside `out`.
- F12: an application inside the root whose tsconfig `outDir` is
  `../../outside/emitted`. `typesys_engineer_verify` makes `tsc` write
  there.
- F10: `mission` is a symlink to a file outside the root. The tool's error
  is `Unexpected token 'T', "TOPSECRET-"... is not valid JSON`, which
  discloses the first 10 characters. A JSON file outside the root that
  parses has some of its values echoed by `invalid-mission` messages (from code reading), such as
  `"<as>" is not one of the mission's callers`.

Fix: `realpath` the deepest existing ancestor of each path and compare that
with the realpath of the root. Open files with `O_NOFOLLOW` where Node
allows it, and pass `outDir` to `tsc` (see H2). Return "cannot read the
mission" without the parser's message.

### M2. Spec strings become code in the scaffold

`missionProblems` checks names and references, but not the types of
several fields that the scaffold interpolates raw:

- `approval.deadlineMs` → `deadline: { afterMs: ${s.deadlineMs} }`
  (`scaffold.ts:108`)
- `view.limit` → `.limit(${v.limit ?? 50})` (`scaffold.ts:165`)
- `view.name` → `export function ${v.name}()` and `<${v.name} />`
  (`scaffold.ts:163-164`, `:209`); it has no validation at all.
- A workflow input name → `ctx.input.${field}` (`scaffold.ts:63`); inputs
  are only checked to be strings (`mission.ts:155`).

F8 sets `deadlineMs` to the string
`(((globalThis as Record<string, unknown>)["m4Injected"] = "deadlineMs"), 86400000)`.
The scaffold writes it into `workflow.ts`, which typechecks and emits, and
importing the emitted module runs it. That is what `verify` does when it
starts the server. The `limit` payload is written into `views.tsx` the same
way.

ADR-0071 does say a spec from someone you do not trust is code, because of
`host.module`. But a reviewer approving a spec reads `host.module` as the
code and `deadlineMs` as a number.

Fix: validate types in `missionProblems`. `deadlineMs` and `limit` must be
non-negative integers, view names must match `^[A-Z][A-Za-z0-9]*$` and be
unique, and workflow inputs must be identifiers. In the scaffold, emit
`ctx.input[${q(field)}]` and `Number(...)`, so an unvalidated spec still
cannot reach code.

### M3. Checks share one server's state

`verifyMission` starts one process and runs every check against it in order
(`verify.ts:247-251`). Its comment says "every check sees the state the
spec describes", but `starts` and `approves` checks open runs and work
orders that later checks see.

V4 appends "no work order exists until a lead approves one" (`query`
`airforce.WorkOrder` as viewer, `atMost: 0`) to the example. The sample data
has no work orders, so it holds of the application, but it **fails with
`count: 1`** because `lead-approves-and-work-order-opens` ran first. The
hint, "this caller reads more than the requirement allows", points at
policy, which is not the cause.

Fix: either start a fresh server per mutating check (or give each one a
fresh host), or document the order semantics in the ADR and the skill and
say in the hint that earlier checks may have changed state.

### M4. Checks with no predicate, or only an absence predicate, pass on any 200

- A `reads` check with neither `sees` nor `withheld` passes on any 200.
- One with only `withheld` passes when the body has no `values`
  (`verify.ts:82`, `?? {}`).
- A `query` with neither bound passes on any 200, and one with only
  `atMost` passes when the body has no `items` (`verify.ts:96`).

F2 shows the last two against a server that answers `200 {}`.
`missionProblems` requires none of these predicates.

Fix: require at least one of `sees`/`withheld` and one of
`atLeast`/`atMost`. Fail when the body is not the shape the API returns
(`values` an object, `items` an array).

### M5. A `refused` check on an object that does not exist passes for everyone

`plan` checks the Type exists, never the object. F5 adds a `refused` check
as the maintainer, who reads every Component, on `comp-does-not-exist`.
Plan reports nothing, and by H1 the check passes. The same holds for
`reads`, `offered.objectId`, and the ids in `starts`/`approves` inputs. A
typo there turns a negative check into a tautology.

Fix: in plan, read each named object with an identity the host lets see it
(or ask the adapter directly), and report `unknown-object` with the nearest
id.

## Low

### L1. A check with no `as` runs as the anonymous caller

`missionProblems` skips a caller that is `undefined` (`mission.ts:186`), and
`runCheck` then uses token `""` (`verify.ts:69`). F4 removes `as` from the
first check, and the spec is valid. A `refused` check written this way
passes for the wrong reason.

### L2. `$step.a.b` is silently cut to `$step.a`

Every parser uses `split(".", 2)`, which drops everything after the second
segment: `mission.ts:166`, `plan.ts` (refFields) and `scaffold.ts:62`. F6
writes `$component.aircraftId.anything`. Plan validates `aircraftId`, the
scaffold compares `aircraftId`, and nothing reports the rest.

### L3. A caller the spec names but no check covers is not reported

F7 adds an `auditor` caller with no check. Plan is silent. `verify` only
ever covers callers that checks name, so a person the requirement mentions
and the spec forgets is unchecked by construction. Plan could list, per
caller, the check kinds that cover them, and warn on a caller with none.

### L4. An unresolvable host module is a rejected promise, not a diagnostic

`verifyMission` calls `loadHost` outside any `try` (`verify.ts:231`), and so
does the CLI (`cli.ts:457`). F14 misspells the module as
`@typesys/domain-airforse`, and `verifyMission` rejects with
`Cannot find module` instead of returning a diagnostic `at: "host/module"`
with the near miss. The CLI prints a stack trace, and the MCP tool returns a
bare error string. The same holds for a missing `build` or `identities`
export.

### L5. `host.module` may name a file outside the MCP root

F11 puts a mission inside the root whose `host.module` is an absolute path
outside it. `typesys_engineer_plan` imports it, and its top-level code runs.
ADR-0071 says the tools "confine paths, not code". `host.module` is a path,
though, and relative or absolute specifiers could be confined while bare
package names stay allowed.

### L6. `insideRoot` refuses `..cache/`

`rel.startsWith("..")` (`mcp.ts:354`) refuses any name starting with two
dots, such as `..cache/mission.json` inside the root (F13). Compare
`rel === ".."` or `rel.startsWith(".." + path.sep)`.

### L7. Diagnostics that point away from the cause

These are from code reading and were not reproduced separately unless
noted.

- A `reads` check that gets 404 for an object that does not exist says
  "the model's read policy refuses this caller" (`verify.ts:81`).
- A passing `approves` check records `{ admitted: false }` and not the 409
  that decided it (`verify.ts:139`; seen in V2).
- V4's hint blames the caller's policy for state another check created.
- `startApplication` takes the first ` on http://127.0.0.1:<port>` printed
  on stdout as the application's address (`verify.ts:195`). A line in that
  form logged by the host module or a dependency before the server listens
  sends every check to that address.
- `typesys engineer` catches every error from `import("@typesys/engineer")`
  and says the package is not installed (`packages/cli/src/bin.ts:150-155`).
  A broken install, or a syntax error in the package, is misreported.

### L8. The scaffold writes what the plan does not list, and `dist/` is never cleaned

Plan's `create` lists 6 files (`plan.ts`). The scaffold also writes
`tsconfig.json` and `index.html` (`scaffold.ts:24-26`), and the former is
what H2 turns on. `build` never removes `dist/`, so after `views.tsx` is
deleted the old `dist/client` bundle is still served by `clientRouter`
(`scaffold.ts:254-255` in the generated server).

## Attacks that held

- The 8 `engineer.*` mutations in `tools/mutation/catalog.json` are each
  killed (`npm run mutation -- --only engineer.…`, which rebuilds with
  `tsc -b --force`): 8 killed.
- Plain `../` paths and absolute paths are refused by `insideRoot` (test
  "held").
- `ident()` quotes non-identifier input and present names in the
  generated `MissionInput` interface and `present` object. JSDoc closing is
  escaped. `q()` is used for every Type, Action, policy, step and field name
  in generated code. The injection surface is the four fields in M2.
- `name` is restricted by regex, so `index.html`'s `<title>` cannot be
  injected.
- The self-approval defect seeded in the application (not the spec) fails
  exactly `lead-cannot-approve-own-request`, as ADR-0071 claims, provided
  the check's `step` is spelled right (H3).
- `verify` starts the application in a fresh process, so an earlier
  build's modules are not reused in memory (the stale build in H2 is on
  disk, not in the module cache).

## Answers to the owner's questions

**Can `verify` report ok on an app that violates its requirement?** Yes.
H2 does it with a stale build. H3 does it with a step typo plus the ADR's
own seeded defect. H1 and M4 give vacuous checks, and M5 a check on an
object that does not exist. On a spec that omits callers it is silent by
construction (L3).

**Can the scaffold diverge from the plan, or be injected?** It writes two
files the plan does not list (L8) and cuts dotted references (L2). Four
spec fields become code (M2), and the guard it generates passes on withheld
data (H4).

**Can the MCP tools escape their root?** Yes, through a symlinked `out`
(writes) and a symlinked `mission` (a read, leaking a prefix). The
application's tsconfig `outDir` and an absolute `host.module` escape it
too (M1, L5).

**Does each diagnostic point at the real cause?** Mostly, for the cases the
loop test seeds. It does not for a missing host module (L4), for
state-dependent results (M3), or for passes and failures decided by 404s
and 409s (H1, H3, L7).

## Disposition (2026-10-14)

All 17 findings are fixed on the same branch. The review's 19 tests now
pass unchanged, except the comment at the top of each file, which still
records that they failed on `0907181`. Each fix has a mutation in
[`tools/mutation/catalog.json`](../../tools/mutation/catalog.json) that a
test kills (`npm run mutation`). M3 is the exception: no one-line change
reintroduces a shared server, so V4 is its only guard. ADR-0071 records
what changed in its "Amended after the independent review" section.

| Finding | Fix | Mutation |
|---|---|---|
| H1 negative checks | a refusal is a 403, or a 404 for an object another caller of the mission reads; `offered` and `described` need a well-formed answer or a 403 (401 for the model); `starts … refused` needs a 403; anything else is "the API did not answer" | `engineer.negative-on-any-failure`, `engineer.hidden-object-uncorroborated` |
| H2 stale build | `dist/` is deleted before every build; verify passes its own `--outDir`, `--noEmit false`, `--incremental false`, `--composite false`, `--declaration false`, `--strict` and `--noUncheckedIndexedAccess`; no `dist/server.js` is a build error | `engineer.app-tsconfig-owns-output` |
| H3 approvals | the spec is invalid when an approves check names a step that is not an approval; verify confirms the run waits on that step before approving; only 200 and 403 decide admission | `engineer.approves-step-unvalidated`, `engineer.approval-step-unconfirmed`, `engineer.approval-any-refusal` |
| H4 withheld comparison | the generated check step fails the run when either side is undefined, saying the initiator may not read it | `engineer.withheld-compare-passes` |
| M1 MCP root | `insideRoot` also compares real paths, following symlinks as far as the path exists; verify owns `outDir`; a mission that cannot be read is reported without the parser's text | `engineer.symlink-escape`, `engineer.mission-read-discloses`, `engineer.app-tsconfig-owns-output` |
| M2 spec strings as code | `deadlineMs` and view `limit` must be whole numbers, view names PascalCase, view fields and workflow inputs identifiers; the scaffold also writes them through `Number()` and `q()` | `engineer.spec-number-as-code` |
| M3 shared server | each check runs against its own freshly started application, four at a time | none (V4) |
| M4 empty answers | a reads check needs `sees` or `withheld`, a query `atLeast` or `atMost`; verify requires `values` to be an object and `items` an array | `engineer.shape-unchecked` |
| M5 object that does not exist | plan reads each checked object as every caller: `unknown-object` (error) when it is missing for all, `object-unconfirmed` (warning) when every caller is refused | `engineer.ghost-object-accepted` |
| L1 no `as` | a missing or unknown `as` or `startedBy` is invalid | `engineer.check-runs-as-nobody` |
| L2 dotted refs | `parseRef` accepts exactly `$head.field`; anything else is an error, and the scaffold uses the same parser | `engineer.dotted-ref-cut` |
| L3 uncovered caller | `caller-unchecked` warning at `callers/<name>` | `engineer.uncovered-caller-silent` |
| L4 host module | `tryLoadHost` turns any load failure into `host-unavailable` at `host/module`, in verify, the CLI and MCP | `engineer.host-failure-throws` |
| L5 host path | under MCP, a host module given as a path must be inside the root, checked before it is imported | `engineer.host-path-unconfined` |
| L6 `..cache/` | `rel === ".."` or `rel.startsWith(".." + sep)` | `engineer.dotdot-name-refused` |
| L7 diagnostics | a reads 404 says the object was not found; a passing approves check records the status that decided it; the application is ready only on `typesys-engineer-ready <nonce> <url>` with a nonce verify gives it; `typesys engineer` says "install it" only when the package itself is missing | covered by the H1 and H3 mutations |
| L8 plan vs scaffold | plan lists `index.html` and `tsconfig.json`; the scaffold replaces each file rather than writing through what is there; `dist/` is cleaned (H2) | none |

New tests beyond the review's: `packages/engineer/test/verify-signals.test.ts`
(a corroborated 404, an approval on a run not waiting on its step, a 409
approval, a 403 on the Action list).
