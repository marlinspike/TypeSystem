# 0097. A Workflow Run Can Be About an Object

## Status

Accepted (2026-10-17). Found by the developer showcase's recall challenge
(`docs/evidence/showcase-challenge/`). Builds on ADR-0057 (governed workflows),
ADR-0065 (continuing authority) and ADR-0079 (the application compiler).
Implemented in `packages/workflow/src/definition.ts` (`about`),
`packages/workflow/src/engine.ts` (`mayReadSubject`, `approverName`) and
`packages/compiler/src/check.ts`, `emit/flows.ts` (`about`, the approval
step's output). Proven by `packages/cold-chain/test/recall-app.test.ts` and
the recall response's acceptance checks.

## Context

A workflow's start policy is decided about the workflow, never about the
object a run will act on. The recall response asks to respond to one notice,
and an embargoed notice is need-to-know for quality assurance: a coordinator
may start the workflow, but not about that notice. Without a way to say so,
the run started, its first read was refused, and the run failed. The caller
got a run id and a failed status instead of a refusal, and the refusal was
recorded only as a failed step.

The same run files a response that names who signed it off. An approval
step's output was `{ approved, comment }`; the engine journaled the
approver's subject id but a flow could not refer to it, and nothing kept the
name they signed in with.

## Decision

A workflow definition may name the object a run is about:
`about: { type, idFrom }`, the Type and the input field holding the id. At
start, after the start policy, the engine reads that object as the
initiator. A refusal refuses the start (`AuthorizationError`, audited as a
denied `workflow.start` with the reason). An object that does not exist, or
whose source is down, is left to the run's own reads, which fail the run as
before. The workflow checker reports an unknown Type or input.

In an application, a flow says `"about": "<input>"`, and that input names
its Type with `objectOf`, as a form already uses it. The compiler checks
both and emits `about`.

An approval decision journals the approver's display name
(`approverName`) beside their subject id, and an approval step's output in a
flow is `{ approved, approver, approverName?, comment? }`. A later step can
then name who signed off: the recall response files
`coalesce($qaSignoff.approverName, $qaSignoff.approver)`.

## Consequences

A caller who may not read the object a run is about is refused the run, on
every surface, with the same 403 a direct read gets. Whether the object
exists is still told apart from a refusal, exactly as a read tells it
(404 against 403); `about` adds no disclosure.

The check is a read made now; a run still reads the object again in its
steps, as the initiator is at that moment (ADR-0065).

The display name is what the identity provider said at sign-in, journaled
once. It is a label for a filing, not an identifier: policy and audit keep
using the subject id.
