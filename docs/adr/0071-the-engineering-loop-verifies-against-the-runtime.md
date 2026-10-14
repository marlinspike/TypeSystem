# 0071. The Engineering Loop Verifies Against the Runtime

## Status

Accepted (2026-10-14). Implemented in `@typesys/engineer`
(`packages/engineer/`): the mission spec (`mission.ts`), `plan.ts`,
`scaffold.ts`, `verify.ts`, the CLI (`typesys engineer`, and
`typesys-engineer` on its own) and the MCP tools (`typesys-engineer-mcp`).
The Claude Code skill is `.claude/skills/typesys-engineer/SKILL.md`. Proven
by `packages/engineer/test/loop.test.ts` (the loop end to end on
`examples/missions/component-replacement`, with defects seeded in the spec
and in the application), `surfaces.test.ts` (CLI and MCP) and
`browser.test.ts` (the generated views in Chromium). Eight mutations in
`tools/mutation/catalog.json` (`engineer.*`) are each killed by one of
these tests.

## Context

TypeSystem 3.0's goal is that an agent can take a requirement to a
running, governed application without a person writing the plumbing. Code
agents (Claude Code and others) already write code well. What they lack,
for an application over a governed model, is a way to know whether what
they wrote does what the requirement says *for each person*. "It compiles"
and "the tests I wrote pass" are both checks the agent sets for itself. The
questions that matter here are of a different kind: can a viewer see this
field, is this Action offered to that maintainer, can a lead approve their
own request. The runtime already decides every one of them, so it is the
runtime that should answer them, through the application's own API.

Building an agent into TypeSystem was the alternative. It would tie the
loop to one provider, and it would duplicate what the agents already do.

## Decision

**A mission spec is data an agent writes and a person reviews**
(`typesys.mission/1`). It holds the requirement in a person's words and the
host (a module that builds the runtime, and the resolver that turns a token
into an identity). It names the callers by the token each signs in with,
and the Types and Actions the application uses. It may add a workflow
(read, check, approval and action steps, with compensation) and views.
Last come the acceptance checks. Each check is one question a client could
ask the API, as one named caller:

- `reads`: what the caller sees, and what is withheld.
- `refused`: the caller is refused the object.
- `query`: how many results the caller gets.
- `offered`: whether an Action is offered on an object.
- `described`: what discovery tells the caller.
- `starts`: the status a run reaches when this caller starts it.
- `approves`: whether this caller is admitted to approve a run another caller started, and the status that follows.

The checks are the acceptance criteria, so they are the requirement made
decidable rather than tests of the generated code.

**`plan` is semantic.** Before anything is written, it reads the spec
against the model as the author sees it (`describeModel`) and as each
caller is told of it (`runtime.describeModel(identity)`, ADR-0068). It
reports four things:

- What already exists: Types and who is told of each, their
  relationships, Actions, and the workflows the host already runs.
- The files the application needs.
- Every problem, as a diagnostic `{code, severity, at, message, hint}`:
  `unknown-type`, `unknown-field` and `unknown-action` (each hint gives
  the nearest name), `unknown-action-input`, `missing-action-input`,
  `workflow-exists`, `uncompensated-action` and `self-approval`
  (warnings), `check-contradicts-model`, and `invalid-mission` for
  structure.
- The location of each problem. `at` is a path into the spec, so an
  agent can edit the exact place.

**`scaffold` writes ordinary code** that a person can read and change:

- `model.ts`, the typed SDK model (ADR-0055).
- `workflow.ts`, a `defineWorkflow` with typed inputs. A check step
  becomes a compute step that fails the run.
- `views.tsx`, React views over `@typesys/react` (ADR-0058).
- `server.ts`, the governed HTTP API (ADR-0058) with the workflow
  registered.
- `acceptance.test.ts`, which runs the spec's checks with Vitest.

Nothing in the output depends on the generator at runtime. The generated
views are bundled for the browser with the core left external. The core
is reached only by the SDK's in-process transport, which a browser never
uses.

**`verify` checks whatever is in the directory**, whether generated or
edited:

1. Plan the mission again.
2. Typecheck and emit with `tsc` (strict, `noUncheckedIndexedAccess`),
   then bundle the views with esbuild.
3. Start `dist/server.js` *in its own process* on a free port. An
   in-process import would keep an earlier build's modules cached, and a
   fresh process is also how the application is deployed.
4. Run every check through HTTP as its caller.

A failing stage stops the run, and the diagnostics point at where to look:

- A compile error is a `compile-error` at `file:line:col`.
- A bundle error is a `bundle-error`.
- A server that never listens is a `startup-failed`, with its last output.
- A failing check is a `check-failed` at `acceptance/<n>`, with what was
  observed and a hint.

`ok` is true only when every stage passes.

**Offered three ways, with one contract:**

- A library (`planMission`, `scaffoldMission`, `verifyMission`, `runCheck`).
- A CLI. `typesys engineer plan|scaffold|verify` delegates to the package
  when it is installed, so the authoring CLI stays small.
- An MCP server over stdio with three tools.

Every surface returns the same JSON. The MCP server is a developer tool,
separate from the governed runtime's MCP server, and every path it is
given must resolve inside the root it was started on. The Claude Code
skill describes the loop to Claude Code, but the contract belongs to
neither Claude nor MCP. Any agent that can run a command, or call a tool
and read JSON, can drive it.

## Consequences

- The demonstration is a requirement no existing code was written for:
  replacing an aircraft component. A lead other than the requester
  approves it, and a work order then opens, compensated by closing it.
  - It goes from spec to a running application whose 12 checks pass
    through its API, and whose views show a viewer the components and
    someone not signed in nothing, in Chromium.
  - Seeded into the application, `allowSelfApproval: true` fails exactly
    one check, `lead-cannot-approve-own-request`, with a hint naming
    `allowSelfApproval`. Removing it verifies again.
  - Seeded into the spec, the same defect is warned of by `plan` and
    fails `verify`. So does a `withheld` check that the model's policy
    contradicts, and a type error in the application is a `compile-error`
    at its line.
- `verify` decides correctness by policy. A check fails when the
  application does something the requirement excludes for some person,
  and a leaked field is reported as the model releasing too much, not as
  a UI bug. The model is still the one place where policy lives (ADR-0052).
- `verify` runs the application and the host module the spec names, with
  the privileges of whoever runs it, as `npm test` does. The MCP tools
  confine paths, not code. A spec from someone you do not trust is code
  from someone you do not trust.
- Not addressed:
  - The checks cover what the runtime decides through the HTTP API. They
    do not cover visual layout, or behaviour that exists only in the
    browser beyond what `browser.test.ts` exercises.
  - The scaffold covers read, check, approval and Action steps. AI steps,
    retries and timers are written by hand in `workflow.ts`, and verified
    the same way.
  - Whether this loop makes an agent more productive than working without
    it is M6's question, not this ADR's.

## Amended after the independent review (2026-10-14)

An independent adversarial review ([docs/reviews/m4-adversarial-review.md](../reviews/m4-adversarial-review.md))
found 17 ways `verify` could say ok, or the tools could act, against this
ADR's intent. All are fixed. Four rules change what the decision above
means:

- **A check passes only on the runtime's own answer.** A negative check
  needs a 403, a well-formed answer that lacks what is refused, or a 404
  for an object some other caller of the mission reads. A missing route,
  an error page or a body of the wrong shape fails every check, so an
  application that does nothing passes none. An approval is tested only
  while the run waits on the named step, and only a 200 or a 403 decides
  it.
- **What runs is what is in the directory.** `dist/` is deleted before
  every build, and verify owns the compiler options that decide whether
  and where output is written. The application's `tsconfig.json` chooses
  everything else.
- **Every check gets a fresh application.** No check sees what another
  wrote, so a verdict never depends on the order of the list.
- **The spec is data, never code.** Numbers must be whole numbers, names
  identifiers, and references exactly `$step.field`. A check names its
  caller and something to assert. Plan reports a check on an object that
  does not exist, and a caller no check covers. The generated check step
  fails the run when its initiator may not read either side.

The MCP tools' root is now checked on real paths, so a symlink cannot
lead out of it. A host module given as a path must be inside the root
before it is imported, and a file that is not a mission is reported
without its contents.

## Amended after the 3.0 pressure test

Found by the [3.0 pressure test](../reviews/3-0-pressure-test.md). Host modules are confined by real path, and a package
specifier with a `.` or `..` segment is refused under a root (E1). A
`query` check counts every page (E2). A `starts` check may name `failsAt`,
the step the run must fail at (E3). The plan and scaffold tools stop any
services the host started (E4).
