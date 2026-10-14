# 0065. Workflows Act on Continuing Authority, with Durable Timers

## Status

Accepted (2026-10-14). Implemented in `@typesys/workflow`
(`WorkflowEngine.reauthorize`, `cancel`, `tick`; `identityMaxAgeMs`,
`inlineWaitMs`; `cancelPolicy` on a definition, `deadline` on an approval;
new journal events), `@typesys/core` (`Identity.expiresAt`) and
`@typesys/auth-oidc` (sets it from the token's `exp`). Proven by
`packages/workflow/test/continuing-authority.test.ts`.

## Context

ADR-0057 made every read and Action of a run go through the runtime as
its initiator, so policy decides each one. Two things were still decided
once, at start, and trusted from then on:

- **Who the initiator is.** The run kept the identity snapshot taken at
  start. An optional `resolveIdentity` re-read their roles on each advance,
  but without it a run acted forever on what its initiator held when they
  started it. Nothing read a token's expiry. A host that re-resolved
  identities could return a *different* subject, and the run would carry on
  as them.
- **Whether they may still run the workflow.** The start policy was
  decided at start only. A maintainer removed from the squadron while their
  run waited for an approval still had the run open a work order, as long
  as the Action's own policy happened to admit them (and when it did not,
  the run *failed* at the Action, which is a worse outcome than not trying:
  it compensates what completed and leaves no way to finish).

Durable execution had the matching gap: a retry's backoff was a sleep in
process memory, and an approval could wait forever. A restart lost the
first, and nothing could end the second.

## Decision

**Authority is continuing, not captured.** Before a run takes any step,
the engine establishes who it acts as now:

1. It re-resolves the held identity with the host's `resolveIdentity`. A
   revoked or unknown subject (`AuthorizationError`, `NotFoundError`)
   suspends the run; any other error is transient and leaves the run as it
   was, to be resumed. Without a resolver, the held identity may be used
   for `identityMaxAgeMs` (default 15 minutes) and the run then suspends
   until its initiator re-authorizes.
2. The resolved identity must be the same subject, and must not be past
   `expiresAt`.
3. The workflow's start policy is decided again for that identity. The
   start policy is therefore the policy for *carrying* a run, not just for
   starting one.

Steps 2 and 3 run again before every effectful step and every
compensation, so a policy change or an expiry between two Actions stops
the run before the second. A refusal journals `authority-suspended`, is
audited as `workflow.authority` deny, and executes nothing. The run's
status is `suspended`, with the reason.

**A suspended run resumes only by re-authorization or ends by
cancellation.** `reauthorize(runId, identity)` admits only the same
subject, unexpired, still admitted by the policy; every refusal is audited.
`cancel(runId, by, reason)` is open to the initiator and, through the
definition's optional `cancelPolicy`, to someone else, who then carries
the run while it undoes what it completed, since the initiator may be why
it is being cancelled. While a run only undoes, the workflow policy is not
re-decided: each compensating Action is decided by the runtime on its own
policy, so a run is never stuck unable to undo because its initiator lost
the right to *start* it.

**Approvals are decided by the approver as they are at decision time.**
This was already so (the approver's identity comes with the call and
their policy is decided then); a decision once recorded stands, and the
Action it allows is still decided at execution time for the identity
carrying the run.

**Timers are journal events.** An approval may declare `deadline:
{ afterMs }`; a retry's backoff is journaled as a timer before it is
waited out. `tick()` fires every due timer: an expired approval
compensates as a rejection does (status `rejected`, reason "expired"),
and a due retry runs. A decision that arrives after the deadline is
refused even if no tick has run yet. Backoffs up to `inlineWaitMs`
(default 1 s) are still waited out in process, but are journaled first,
so a crash during one is honored after a restart. `tick()` may be called
by many processes: the journal's conditional append (ADR-0057) lets one
advance a run and the others skip it.

## Consequences

- No run acts on permissions captured at initiation for longer than the
  deployment allows, and a host with a resolver (the normal case for a
  real identity provider) makes that "never".
- Running a long workflow now needs one of: a resolver, or initiators who
  come back to re-authorize. That is deliberate; the alternative is the
  gap this closes.
- `RunStatus` gains `suspended`, `waiting-timer` and the final
  `cancelled`; `RunView` gains `timers`. `resumeAll` skips suspended runs.
  The one earlier test that expected a revoked initiator's run to *fail*
  at the Action now expects it to be suspended before it.
- A deadline that passes while a run is suspended still expires the
  approval, so the run compensates once someone can carry it.
- Still open: a host that cannot re-resolve identities has only the age
  limit; there is no delegation (a run handed to another person who then
  carries it forward rather than only undoing it); timers are checked when
  `tick()` is called, so their precision is the schedule's.
