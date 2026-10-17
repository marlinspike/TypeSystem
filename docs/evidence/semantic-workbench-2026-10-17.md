# The semantic workbench measured, 2026-10-17

This page measures what the 5.0 tools (ADR-0088 to ADR-0095) change for a
developer or coding agent working on systems they have not seen. No model
was called, and nothing here cost money.

Every figure was **measured** by
[`scripts/measure-workbench.ts`](../../scripts/measure-workbench.ts),
which writes [`semantic-workbench/results.json`](semantic-workbench/results.json),
unless it is marked otherwise. The run was on commit `c798f08` plus the
context change described below, with Node 22.22, in a cloud container
with a shared CPU. To reproduce:

```sh
npm run build
npx tsx scripts/measure-workbench.ts
```

## What was compared

The mandate asks for three arms: (A) ordinary APIs and TypeScript, (B)
TypeSystem's runtime and composition tools, and (C) B plus the new
context, diagnostics and verification. Running those arms as agents or
people costs money or needs a person, so this evaluation measures the
part that does not: **what each arm's tools return for the same
question, whether it is right, how many calls it takes, and how many
tokens an agent would read to get it.**

- **Arm A** is the domain's source, read as a developer reads it. Its
  cost is every source file in the package that names the thing asked
  about, read whole. Nothing is run.
- **Arm B** is the runtime as 4.0 shipped it: `describeModel`, `query`,
  `getObject`, `getRelationship`, `explainQuery`, `previewAction`,
  `diffModels`, and the 4.0 context compiler, taken from commit
  `1f40e56` and run unchanged.
- **Arm C** is the same runtime with `explain`, `inspectModel`, the
  dependency graph, the task-aware context, change impact and link
  probes.

**Ground truth never comes from the code being measured.** It comes from
the definitions (the Type schemas, the application spec, the workflow
source) or from plain reads before and after a change. The seven
investigation questions and four requirements below were written for
this evaluation. No test, fixture or document in the repository uses
them.

**Contamination, stated plainly.** The questions, requirements and
changes were written by the same agent that built the tools. Their
ground truth is mechanical, but the choice of what to ask is not. A
reviewer who did not build TypeSystem should choose the next set.

## Investigating unfamiliar behavior

Each cell gives whether the arm's output states the truth, the calls it
took, and the tokens an agent reads. For arm A, the tokens are the
source files it must read.

| | Question | A: read the source | B: 4.0 runtime | C: 5.0 tools |
|---|---|---|---|---|
| Q1 | Why does the viewer not get `maintenanceStatus` on AF86-0147? | yes, 4 files, 5,109 | partly, 3 calls, 621 | yes, 1 call, 840 |
| Q2 | Why does the viewer not get `readinessStatus`? | yes, 5 files, 5,445 | partly, 3 calls, 621 | yes, 1 call, 497 |
| Q3 | Why does the viewer not get `deploymentLocation`? | yes, 3 files, 3,784 | partly, 3 calls, 621 | yes, 1 call, 840 |
| Q4 | Why is the viewer refused CreateMaintenanceWorkOrder? | yes, 6 files, 3,390 | partly, 2 calls, 104 | yes, 1 call, 339 |
| Q5 | What in the squadron application and GroundForRepair is built on `maintenanceStatus`? | yes, 2 files, 3,585 | no | yes, 1 call, 1,683 |
| Q6 | Which system does a shipment's destination Site come from, and does the link resolve? | yes, 1 file, 3,221 | yes, 3 calls, 596 | yes, 1 call, 390 |
| Q7 | Appointment APT-0404 shows no patient. Missing, refused, or never linked? | no | no, 1 call | yes, 1 call, 212 |

**Where C helps most.** Q5 and Q7 have no answer in arm B at all. No 4.0
tool relates a value to what is built on it. One dependents query names
all five parts and workflows that use `maintenanceStatus` or a value
computed from it, plus two more that use them through another part. And
a dangling reference looked exactly like an empty relationship (ADR-0048)
until an inspector could explain a caller's read of it. Arm A cannot
answer Q7 from the definitions either, because it is a fact about the
data.

**Where C helps less than expected.** For a caller asking about their
own access (Q1 to Q3), the 4.0 query plan already lists which values a
member policy redacts and which are marked. An expert reading it gets
most of the answer from B. C's own explanation to the viewer says the
same thing more directly: `member-policy`, `classification`,
`derivation`. The policy name, its rule and the remedy come only from an
inspector's explanation. That is what arm A gets from reading 4 to 5
files, at five to ten times the tokens. Q6 is answerable in B by
following the link and reading the Site's provenance, one object at a
time. C answers for every cross-system link of the Type at once.

**Leaks.** Nothing in C's caller-facing output named a policy, marking
or source the caller may not learn of. B did: the 4.0 query plan names
the Aircraft's data source (`in-memory-airforce-repo`) to the viewer,
which the inspection treats as enforcement structure (ADR-0088). This is
listed as a finding in the 5.0 pressure test.

## Context for a new requirement

Four requirements, compiled for the caller they are for, by the 4.0
compiler (B) and the 5.0 one (C). The fourth avoids the model's
vocabulary on purpose ("jets overdue for upkeep").

| | Requirement | Caller | Tokens, B to C | Needed Types and Actions, B and C | Withheld values explained, B and C | Checks, B and C |
|---|---|---|---|---|---|---|
| R1 | Viewer list of aircraft that need attention, with components | viewer | 739 to 1,110 | 2 of 2, both | 0 and 3 of 3 | 0 and 3 |
| R2 | Maintainer opens a work order from the history page | maintainer | 756 to 1,149 | 4 of 4, both | none withheld | 0 and 3 |
| R3 | Report of components in poor condition, by aircraft | viewer | 724 to 1,124 | 2 of 2, both | 0 and 3 of 3 | 0 and 3 |
| R4 | Flag jets overdue for upkeep | maintainer | 895 to 1,339 | 3 of 3, both | none withheld | 0 and 3 |

**Negative result: selection did not improve.** Both compilers chose the
same Types for every requirement, including the one with no shared
words. Both include 3 to 8 Types a correct implementation does not need.
The dependency-complete selection (ADR-0092) changes which Types are
kept when the budget is tight. None of these four was tight, so these
four requirements do not show any benefit from it.

**What C adds** is in the statements, not the selection. The viewer's
three withheld values are marked with the control that withholds them,
where B said only "not returned to this caller". C names the parts of
the application and the workflows that already use each Type, the
acceptance checks a change must keep passing, the query rule and the SDK
call. Neither compiler leaked anything.

**Cost.** C's context is 1.5 times B's on these requirements, about 370
tokens more. This evaluation found the first version at 1.8 times. Each
part that used a Type had a line of its own (eight for Aircraft, then
"15 more"). That is now one line per application or workflow, naming
its parts, and the change is part of this slice. Most of what remains
is fixed text: the query and SDK rules, the marks legend, the checks and
the caveat. It does not grow with the model.

## Changes to the model

Six changes to the Air Force model, each analyzed against the squadron
application and GroundForRepair. The truth is what the viewer was
actually returned on AF86-0147 before and after, read plainly.

| | Change | What the viewer gains or loses | B: `diffModels` | C: `analyzeChange` |
|---|---|---|---|---|
| X1 | Release `readinessStatus` to every reader | gains `readinessStatus` | compatible, nothing found | risky; the exposure, 3 consumers, 1 check |
| X2 | Take the member policy off `maintenanceStatus` | gains `maintenanceStatus`, `readinessStatus` | compatible, nothing found | risky; both exposures, 3 consumers, 2 checks |
| X3 | Guard `tailNumber` with `maintainer-only` | loses `tailNumber` | compatible, nothing found | risky; the narrowing, 3 consumers, 2 checks |
| X4 | Drop the SECRET marking from `deploymentLocation` | gains `deploymentLocation` | compatible, nothing found | risky; the exposure, 3 consumers, 1 check |
| X5 | Remove the `model` value | loses `model` | breaking | breaking; 3 consumers, 1 check |
| X6 | A patch version bump and nothing else (control) | nothing | compatible | compatible, nothing found |

The contract diff misses every one of the four governance changes. Two
of them hand the viewer a value a policy or marking was written to
withhold. C reports each with the right direction and no false positive
on the control. Recording a baseline of the model with two callers took
15 ms and is about 6,100 tokens. Each comparison took 3 to 6 ms.

**A defect found by this measurement.** On the first run, X5's truth
column was empty: with `model` removed from the schema, the viewer was
still returned it. A wildcard mapping passed every column a source held
straight through, so any undeclared value reached every reader of the
object and could be filtered on. The hospital's sample patients carried
a `name` the model never declared. ADR-0095 fixes it, with its own test
and two mutations. The table above is from after the fix.

## What this does not measure

The following need a person or a paid model run, and none was done.

- **Time to a correct implementation, tool calls in a real session, and
  human intervention.** These need the agent or developer to do the
  work. The three-arm harness (ADR-0073, `npm run evaluate`) can score
  such runs. The estimate in
  [evaluation-estimate-2026-10-16.md](evaluation-estimate-2026-10-16.md)
  still applies to arms A and B.
- **Whether an agent uses what C gives it.** Tokens read are an upper
  bound on what helps. An agent may ignore the marks or the checks.
- **Maintenance effort over months, and models larger than the
  examples.** The largest model here, the Air Force one with its core Types, has 10.
- **Whether a developer finds the Studio views faster than the CLI.** The
  Studio tests prove the views are correct, not that they are quicker.

## What this changes next

C's clearest advantage is on questions B has no answer to: what depends
on a value, and whether a change alters who sees what. Those are where
further work should go. The context compiler's selection is no better
than 4.0's on these requirements, so improving relevance needs a harder
benchmark with a tight budget before it gets more work. The 4.0 query
plan's disclosure of source ids to callers is fixed in the pressure
test.
