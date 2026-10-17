# 0096. An Action Can Require an Approved Workflow Step

## Status

Accepted (2026-10-17). Found by the developer showcase's recall challenge
(`docs/evidence/showcase-challenge/`). Builds on ADR-0055 (workflows),
ADR-0057 (the checker and simulation) and ADR-0065 (continuing authority).
Implemented in `packages/core/src/runtime/runtime.ts` (`invokeAction`,
`previewAction`, `listActions`, `explain`), `packages/workflow/src/engine.ts`
(`grantedApproval`), `packages/workflow/src/validate.ts`
(`unapproved-action`) and `packages/compiler/src/check.ts`
(`approval-required`). Proven by
`packages/workflow/test/approval-required.test.ts`.

## Context

A workflow's action step invokes its Action as the run's initiator, so the
Action's policy must admit the initiator. The same policy then admits the
initiator calling the Action directly, over REST or MCP, with no approval at
all. The approval step governed the workflow, not the Action.

The recall challenge made this concrete: quarantining the lots on a recall
notice and filing the response with the exchange must happen only after
quality assurance signs off, and never on the requester's own sign-off. Both
agents that built the challenge without this ADR worked around it, one with
a hidden field only a service identity could read, the other with a policy
that inspects how the call was made. Each workaround was local to one
application, and neither was visible in the model.

## Decision

An Action may declare `requiresApproval: true`. The model description says
so (`ActionDescription.requiresApproval`), so every consumer (Studio, MCP,
the compiler, generated clients) sees it.

The runtime then refuses `invokeAction` unless the call carries an
`ApprovalGrant` (`{ workflow, runId, step, approvedBy }`) whose approver is
not the caller. The refusal is an audited deny with the reason; the caller
sees the usual "Not authorized". The policy is still decided first, so the
Action's own policy keeps its meaning. A successful invocation records the
grant in the audit details.

`previewAction` reports an `approval` blocker and `authorized: false`, and
`listActions` lists the Action as not authorized, since no direct call can
run it. `explain` reports the blocker as an `approval` finding.

The workflow engine passes the run's most recent granted approval with each
action step and compensation. A simulation passes its scripted approvals,
whose approvers are decided by the real policy, so it previews what a live
run would do.

The workflow checker reports `unapproved-action` when an action step (or its
compensation) invokes such an Action with no approval step it reads from that
always runs before it (no condition, or the step's own). The application
compiler reports the same diagnostic for flows and `approval-required` when a
page invokes the Action directly.

## Consequences

The sign-off is part of the Action's definition, enforced in one place for
every surface, and an engineer reads it in the model rather than in an
application's code.

The grant is an in-process argument, not a credential. REST, MCP and
demo-web never forward one, so no remote caller can supply it, but code that
holds the runtime object can construct one. That is the same trust boundary
as the rest of the runtime: code in the process is trusted.

The grant names a run but the runtime does not look the run up; the engine
is the only caller that passes one. A deployment that runs the engine in a
separate process would need a signed grant, which this ADR does not provide.
