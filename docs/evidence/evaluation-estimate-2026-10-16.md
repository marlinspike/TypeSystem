# The M6 evaluation, estimated without paid runs, 2026-10-16

The three-arm evaluation of [ADR-0073](../adr/0073-the-evaluation-is-decided-by-hidden-checks.md)
has not been run, because its agent arms spend money and the owner chose
not to. This document estimates what it would have found. Every figure is
marked as **measured** (run or counted on commit `a82e935`, Node 22.22)
or **estimated** (inferred, with its basis and a range). No model API was
called to produce it.

**Assumption, from the owner.** Both agent arms are Opus 5.5 at high
effort, a very strong coder. The estimate therefore assumes no basic
coding mistakes in either arm. The differences below come only from what
each approach structurally requires the producer to write, and from what
it gives them without writing anything.

## Headline

On the 43 hidden checks, the two agent arms are estimated to finish close
together: **42 to 43** with the composition platform and **39 to 43**
without it. That is not where TypeSystem's advantage shows, and the
measurement below explains why: the no-platform arm still runs on
TypeSystem's core runtime, which enforces every read rule the checks
test, and a strong coder can write the remaining process rules by hand.

The advantage shows in what the hidden checks do not see. The
no-platform builds written for this estimate pass 43 of 43 checks, and
still lack every one of the four governance properties weighted highest
below: one enforcement point for the process rules, durable runs,
compensation, and audit of workflow decisions. A composed build has all
four without writing them. The platform build also authors 17% to 31% as much as the hand-written one,
and carries its own acceptance checks.

## What was measured

**The reference applications.** Each task's mission spec, scaffolded by
the engineering loop with no hand edits, is the closest free stand-in for
the agent-with arm's output: that arm writes a spec and runs `scaffold`
and `verify`. Scored with the harness's own `scoreApp`.

**No-platform builds.** One application per task, written by hand for
this estimate under the agent-without arm's rules: `@typesys/core`, the
domain packages and `node:http`, and no `@typesys/http` or
`@typesys/workflow`. They are in
[`evaluation-estimate/no-platform/`](evaluation-estimate/no-platform/),
and the raw scores of both sets are in
[`evaluation-estimate/scores.json`](evaluation-estimate/scores.json).
They were written in the same session that had just read the hidden
checks and the references, so their score is an **upper bound** for the
agent-without arm, not a run of it. They stand in for a strong coder who
reads the requirement closely; the code measures are not affected by what
was read.

| | Reference (platform) | No-platform build |
|---|---|---|
| Hidden checks, component replacement | 14 / 14 | 14 / 14 |
| Hidden checks, requisition expedite | 14 / 14 | 14 / 14 |
| Hidden checks, sortie confirmation | 15 / 15 | 15 / 15 |
| Authored by the producer | the spec: 0.86 to 1.69 KB | the server: 4.9 to 5.4 KB |
| Self-tests the producer also wrote | 8 to 15 acceptance checks per task (1.4 to 2.9 KB) | none |
| Code lines, as the harness counts them | 200 to 341 (mostly generated: typed model, views, tests) | 96 to 107 |
| Process rules restated in application code | 0 | 9 (3 per task) |
| Restated access rules, as the harness counts them | 0 | 0 (see "A gap in the harness") |
| Branch points per 100 lines | 4.5 to 8.2 | 49.5 to 55.7 |
| p50 / p95 latency over the checks, ms | 12 / 48 (component replacement) | 5 to 11 / 20 to 76 |

Authored size is the spec's workflow, host, callers and Types, and the
server's source, both minified the same way (comments dropped, whitespace
collapsed). Latency is noise at this scale, as it was in
[the mission-app comparison](mission-app-2026-10-13.md).

**Which checks depend on what.** Of the 43 checks, 13 test reads and
queries (field absence, 403 for nothing readable, the crew name by unit).
Both arms get these from the core runtime without writing a rule. The
other 30 drive the workflow endpoints and depend on the process the
producer supplies. In a composed build that process is a declaration the
engine executes. In a no-platform build it is the producer's own code,
and in these three tasks it came to nine rules:

- the person who asked may not approve (once per task);
- a run is visible to its starter, and to an approver only while it waits on them (once per task);
- the state check: the component and event on one aircraft, the requisition still awaiting, the pilot assigned to the aircraft.

Each rule is stated in the requirement or the contract, which is why a
strong coder gets them right. Choosing the right policy for starting and
for approving (six choices) was the other place a build can go wrong, and
both builds named the domain's policies rather than restating roles.

## The estimate for each arm

| Arm | Hidden checks, of 43 | Basis |
|---|---|---|
| agent-with | **42 to 43** (estimated) | The references pass 43 (measured). The agent writes its own spec; the engine supplies self-approval refusal, run visibility and the failed-run contract, so the remaining risk is the spec's choice of policies and state checks. `verify` runs the agent's own acceptance checks before it finishes. |
| agent-without | **39 to 43** (estimated) | The no-platform builds pass 43 (measured, upper bound). The 30 workflow checks rest on nine hand-written rules and six policy choices. The one most likely to be missed is run visibility to a waiting approver: the task authors themselves first wrote it wrong (ADR-0073). One missed rule costs one to three checks. |
| conventional (a person) | not estimated | It needs a person. A developer under this arm has the same packages as agent-without, so the same structural analysis applies, but nothing here measures a person's error rate. |

**Cost and time** (estimated, low confidence). Both arms' cost is
dominated by what the agent reads, not what it writes. The agent-with arm
has the skill and `typesys engineer plan`, which describe the model to
it. Writing the no-platform builds needed lookups in five source files
(the runtime's read and query signatures, its error classes, the policy
decision helper, and both domains' setup) before the first line. The
agent-without arm is estimated to take 1.0 to 1.5 times the agent-with
arm's tokens and wall time. The total for 18 runs stays within the
earlier range: $150 to $450 on Opus 5.5.

## The advantages, weighted

The hidden checks decide the evaluation's score. They cannot see the
properties below, so each is credited here on its own line, with its
weight and its basis.

- **Weight 3:** a governance property that is absent or wrong on some path in the no-platform build, and that no hidden check sees.
- **Weight 2:** a cost the no-platform build pays again on every future consumer or policy change.
- **Weight 1:** size or convenience.

Evidence is **M** (measured, here or in earlier evidence), **I** (read
from the code, deterministic) or **E** (estimated).

| Advantage | Weight | Platform build | No-platform build | Evidence |
|---|---|---|---|---|
| One enforcement point for people and agents. The process rules live in the workflow, so an MCP agent starting the same workflow is held to the same rules. | 3 | yes | no: the nine rules live in one HTTP server; a second consumer calling the runtime directly is not held to them | I |
| Durable runs: the journal, crash recovery, replay and approval deadlines (ADR-0065, ADR-0066). | 3 | yes | no: runs are an in-memory `Map`; a restart loses every waiting approval | I |
| Compensation. Component replacement requires that a work order which cannot finish is closed again. | 3 | yes (`compensate` on `openWorkOrder`) | no, and no hidden check tests it | I |
| Audit of workflow decisions. The engine audits every start and approval, allowed or refused, with its reason (`packages/workflow/src/engine.ts:183`). | 3 | yes | no: the core audits reads and the Action, not the application's own decisions | I |
| Process rules written once. | 2 | 0 restated | 9 restated, in three applications | M |
| A policy change takes effect with no edit. | 2 | yes | partly: the start and approval policies are named, so they follow; self-approval and run visibility are restated, so they drift (measured drift in [the mission-app comparison](mission-app-2026-10-13.md)) | M, I |
| The next consumer adds no rules. A model through `@typesys/mcp-server`, or a second application, uses the same workflow. | 2 | 0 new rules | either routes through this server or restates the nine rules | I, E |
| Typed client, OpenAPI and React views, generated. In the mission-app comparison, five of six slip classes became compile errors. | 2 | yes (`model.ts`, `views.tsx`, `/api/openapi.json`) | no | M |
| Self-tests the loop runs before it finishes. | 2 | 8 to 15 per task | none | M |
| What the approver is shown. Each approval presents what is being approved, read with the approver's permissions. | 1 | yes | no | I |
| Authored size. | 1 | 17% to 31% of the hand-written server | 100% | M |

Every weight-3 property is present in the platform build and absent from
the no-platform build, and none of the four is visible to the hidden
checks. The no-platform builds would need to write each of them, and
then keep them in step, to match.

## What both arms already get from TypeSystem's core

The agent-without arm is "without the composition platform", not
"without TypeSystem". Both arms receive the following from the core
runtime, so the evaluation cannot credit either for it. Against a stack
with no TypeSystem at all, every line is a rule each consumer would
restate (read from the domain models):

- the object and field policies of both domains: `airforce.read-aircraft` on four Types, `maintenanceStatus` for maintainers only, and the five `ops.*` rules, including the crew name shown only to a planner of the same unit;
- the SECRET classification of `deploymentLocation`, enforced beside policy;
- computed values, with `readinessStatus` withheld because it maps a withheld field, and `needsAttention` released by design;
- one object model across three independent services, each with its own authorization, joined without the application calling any of them (0 direct service calls in every build);
- per-value provenance, and audit of every read and Action.

The 13 read checks pass in both arms because of this. A no-TypeSystem
application was not built or measured here, so its size and error rate
are not estimated.

## A gap in the harness

The harness's `restatedAccessRules` counts role and token literals in
comparisons. It reads 0 for the no-platform builds, which compare subject
ids for self-approval and run visibility instead, so it misses all nine
restated rules. Two kinds of hidden check would let a run see the
weight-3 properties: one that restarts the application while a run waits
for approval, and one that makes the work order fail to finish in
component replacement (the check file notes this path is untested today).

## To reproduce

After `npm ci && npx tsc -b`, the references are scored by
`packages/evaluation/test/harness.test.ts`. A no-platform build is scored
with the harness's `score` command, which writes a result file under
`packages/evaluation/results/`:

```sh
npm run evaluate -- score --task requisition-expedite --arm agent-without \
  --dir docs/evidence/evaluation-estimate/no-platform/requisition-expedite \
  --source person --producer "no-platform estimate build"
```
