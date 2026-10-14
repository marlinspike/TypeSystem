# 0073. The Evaluation Is Decided by Hidden Checks

## Status

Accepted (2026-10-14). The harness, the tasks and the hidden checks are
in `packages/evaluation/`, proven by
`packages/evaluation/test/harness.test.ts`. No arm has been run yet. Agent
runs spend money, so they wait for the owner's approval of their expected
cost (see Consequences).

## Context

Milestone M6 asks whether the composition platform makes building a
governed application faster or better, and asks for the losses as well
as the wins. Three things would make any answer worthless:

- **Shared knowledge.** If the person who wrote an application also wrote
  the checks that judge it, the checks measure agreement, not
  correctness.
- **Different instructions per arm.** If one arm is told more than another,
  the comparison measures the instructions, not the platform.
- **Prior art.** If an arm can read an existing solution to the task (a
  mission spec, a test, a review report, the repository's history), it is
  copying, not building.

## Decision

**Three arms, one requirement.** Every arm is given the same requirement
text word for word, and the same application contract
(`tasks/CONTRACT.md`):

- an HTTP API under `/api`;
- `npm start` on `PORT`;
- one table of requests and answers.

The arms differ only in what they may use:

| Arm | Producer | May use |
|---|---|---|
| `conventional` | a developer, by hand | the original runtime: `@typesys/core`, the adapters, authentication, policy, and the two domain models |
| `agent-without` | an AI agent | the same packages |
| `agent-with` | an AI agent | those, plus the composition platform (`@typesys/http`, `workflow`, `sdk`, `react`, `packs`, `studio`, `devkit`, `engineer`) and the engineering loop's MCP tools and skill |

An import an arm was not given is reported as an off-arm import beside
its result, never silently excused. The domain packages depend on the
workflow package, so it cannot be removed from the copy an arm works in.

**Hidden checks written independently.** Each task's checks
(`hidden/<task>.mjs`) were written by a separate agent. It read only:

- the requirement texts and the contract;
- the data and rules the requirements point to (the domain models' sample
  data and policies, and the services' code).

It was barred from every mission spec, the engineering loop, existing
applications, tests and reviews.

Before any arm ran, the checks were run against a reference application
for each task: the task's mission spec, scaffolded by the engineering
loop with no hand edits (`references/`). The disagreements were gaps in
the texts, not in the checks. The contract did not say that a query of a
Type the caller may read nothing of is refused (403), or who may read a
run back. Two requirements did not say whether the person who asks may
also approve. The texts were clarified, and every arm receives the
clarified versions. The same agent then updated its checks from the
clarified texts alone. A second run found one of the clarifications
wrong: an approver may read a run while it waits on them. The contract
was corrected, and the agent corrected its checks the same way. The reference passing every check shows the
checks can be passed. It is not an arm's result: the reference was
written by the people who wrote the tasks.

**Isolated sandboxes.** An agent works in a copy of the repository
(`createSandbox`). The copy leaves out:

- `.git`;
- the evaluation;
- `examples/missions`;
- every package's tests;
- `packages/mission-readiness`;
- the evidence and review documents.

The engineering loop's skill is copied only for the arm offered it. Every
copy is scanned for files naming the task's workflow or approval step,
and any such prior art is reported with the run. The first task was the
engineering loop's own example before this evaluation existed, so it was
not written blind. It stays in the evaluation, labelled as written before
M4. Its scan finds five files in the agent-with sandbox naming its
approval step `leadApproval`, which the airforce domain's own workflow
also uses; the other two tasks have none.

**What is recorded, per run.**

- From the producer: wall time, tokens (input, output, cache read, cache
  write), cost, and human interventions. From the agent, these come from
  Claude Code's own JSON result.
- From the application:
  - each hidden check, pass or fail, with its message;
  - whether it built and started;
  - its code lines and files;
  - imports;
  - direct service calls;
  - access rules restated in application code;
  - branch density (branch points per 100 lines, the maintainability
    measure);
  - p50 and p95 request latency.

A measure the producer cannot supply is reported as "not measured", never
estimated. Each hidden check runs against its own freshly started
application, so no verdict depends on another check.

**Every loss is shown.** The report (`npm run evaluate -- report`) lists
every run, not averages. A loss is any run that passed fewer hidden
checks than the best run of another arm on the same task. Each loss is
shown with the checks that decided it and their messages; the reasons
behind them are written up by hand from those messages.

## Consequences

- Three tasks, 43 hidden checks:
  - `component-replacement`, written before M4;
  - `sortie-confirmation`, written after M4;
  - `requisition-expedite`, written for this evaluation.
- An agent run executes `claude -p` headless in a sandbox:
  - `--max-budget-usd` caps each run;
  - `--strict-mcp-config` admits only the engineer tools for the arm
    offered them.
  It refuses to start unless `--allow-spend` is passed, which is done only
  after the owner approves the expected cost.
- The conventional arm needs a person. Until one builds the applications,
  that arm is reported as not run, not replaced by an agent's work.
- Not addressed:
  - The sandbox is a filesystem copy, not a security boundary. An agent
    with shell access could still read the real repository by its
    absolute path, so the scan for prior art is a disclosure, not a
    guarantee.
  - Repair iterations are not counted for agent runs. Claude Code's JSON
    result reports turns, not why each was taken.

## Amended after the 3.0 pressure test's addendum

Found by the [3.0 pressure test](../reviews/3-0-pressure-test.md). Every negative hidden check first asserts that a permitted
caller is served, so an application that refuses everything passes none
(P3-V1). Sandboxes link third-party packages from a store outside the
repository, made once per lockfile, so no relative path through
`node_modules` reaches the hidden checks (P3-V2). An import by a path that
leaves the application, or of a workspace package the arm does not list, is
reported as off-arm for every arm (P3-V3). A loss is measured against the
best run of another arm (P3-V4). The report shows each run's notes,
including prior art, and every arm without a run as not run (P3-V5);
`evaluate report` works with no results yet, and `--out` refuses a
directory that already holds files (P3-V6).
