# 0093. Change Impact Is Predicted From Definitions and Observed on Decisions

## Status

Accepted (2026-10-17). Builds on ADR-0056 (contract diff), ADR-0088
(inspection), ADR-0089 (explanations) and ADR-0090 (the dependency graph).
Implemented in `packages/devkit/src/impact.ts`. Exposed through
`typesys app impact` (CLI), `typesys_impact` (MCP), `GET /impact/baseline`
and `POST /impact` (HTTP), and Studio's Impact tab. Proven by
`packages/devkit/test/impact.test.ts`, the impact cases in
`packages/compiler/test/uses.test.ts`, `packages/http/test/workbench.test.ts`
and `packages/mcp-server/test/workbench-tools.test.ts`, and
`packages/studio/test/impact.test.ts` (Chromium).

## Context

`typesys diff` classifies contract changes between two described models
(ADR-0056). It does not see governance: a policy taken off a value, a
marking removed, or a computed value newly released from its inputs'
policy changes nobody's contract. It does change who reads what. A
contract diff also does not say what is built on the changed thing.

Releasing `readinessStatus` to every reader of an Aircraft looks like a
small convenience, the same as `needsAttention`. But `readinessStatus`
maps the maintainer-only `maintenanceStatus` one to one. Releasing it
shows every viewer what the policy withholds from them. No contract
changes, so no diff catches it.

## Decision

**A baseline records the model and its decisions, never its data.** It
is `typesys.baseline/1` and holds:

- the description, as its recorder is told it;
- the inspection, when the recorder may inspect;
- for each Type, the first objects the recorder may read (one by
  default), and how each named caller's read of each one is decided.
  That is the explanation's outcome for the read, and each value's
  outcome (`returned`, `withheld`, `no-value`).

The baseline holds object ids, but no values. It can be committed beside
the code it describes.

**`analyzeChange(before, after, consumers)` compares two baselines.** It
finds three kinds of change:

- **Contract** (predicted): `diffModels`, unchanged, including what is
  under-versioned.
- **Governance** (predicted): two inspections compared. This covers
  object and value policies, markings, the inputs a computed value is
  released from, the sources it reads, where values and relationships
  come from, Action policies, sources and audit, preconditions, policy
  rules, and whether each source is connected. Each change says whether
  it `narrows` who may read or invoke, `widens` it, or `changes` it
  without a plain direction.
- **Observed**: each caller's recorded read is compared with the same
  read decided now. A value a caller is newly returned is an
  **exposure**, and is listed first.

Each change is mapped to its node in the dependency graph. Its dependents
among the consumers given are listed with it: the workflows and
applications, their parts, and the acceptance checks among them. An
acceptance check is an application's `check.<id>` part. A workflow's own
`check` step runs inside the workflow and is not one. The checks every
change reaches are listed once, as the checks to run.

**The verdict** is the worst contract impact. Any governance or observed
change makes it at least `risky`. The CLI exits 1 on a breaking change, an
under-versioned one, or an exposure, so a pipeline can stop on it.

**Every surface records the same way.**

- The CLI holds the application's callers' tokens, so each caller
  explains their own read.
- A server (HTTP, MCP) uses `governedBaseline`. It records the caller's
  own reads. When the runtime lets the caller inspect, it also records
  every subject in the host's directory, explained by the caller as that
  subject (`explain` with `as`). The runtime gates and audits each of
  those. The directory is not asked for a caller who may not inspect.
- A baseline sent to a server is checked for its shape before it is
  compared. Comparing reads the model now as the caller and nothing
  else, so a forged baseline can only mislead its own sender.

**One demonstration is shipped.** `releaseReadinessToViewers` and
`buildAirforceProposal` in `@typesys/domain-airforce` build the proposal.
`npm run impact:demo` analyzes it against the squadron application and
GroundForRepair. The analysis reports:

- the release, as a governance change that widens;
- the viewer newly returned `readinessStatus` on AF86-0147, as an
  exposure;
- the application, both flows and the board's acceptance check that the
  change reaches.

## Consequences

- The question "what does this change do to who sees what, and what must
  I re-run" has one answer in the terminal, from an agent, and in the
  workbench.
- Observed changes are as good as the objects probed. A rule that
  depends on a value of an object nobody probed is caught only by the
  predicted governance change, if the rule itself changed. A policy
  engine that cannot describe its rules leaves a rule change unseen,
  except where a probed read changes. The caveat on every analysis says
  so.
- A baseline grows with the model and the callers. The HTTP route
  accepts request bodies up to 256 kB. The Air Force baseline with three
  callers is about 25 kB.
- Recording explains one read per caller per Type. Each is an audited
  call: a baseline is not free to take on a large deployment.
