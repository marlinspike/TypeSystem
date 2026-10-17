# 0089. An Explanation Is the Runtime's Own Decision, Replayed

## Status

Accepted (2026-10-17). Builds on ADR-0088 (inspection), ADR-0030 (member
policies), ADR-0032 (classification), ADR-0052 (derivations and
releases), ADR-0067 (audiences), ADR-0068 (discovery) and ADR-0042
(audit operations). Implemented in `packages/core/src/runtime/explain.ts`,
`SemanticRuntime.explain` and `packages/workflow/src/explain.ts`
(`WorkflowEngine.explain`). Proven by
`packages/domain-airforce/test/inspect-explain.test.ts` and
`packages/workflow/test/explain.test.ts`.

## Context

The runtime decides every member of every read separately and audits each
decision with its reason. The caller sees only absence: the viewer's
Aircraft has no `maintenanceStatus`, no `deploymentLocation` and no
`readinessStatus`, for three different reasons (a member policy, a
SECRET marking, a derivation from the first), and nothing tells them or
the developer debugging them which. Reading the audit log answers it, for
someone who knows where to look and how to join the rows.

A second evaluator that predicts decisions would drift from the real one.
A static check that says "allowed" would be wrong whenever a rule depends
on an object's attributes.

## Decision

**One call, four questions.** `runtime.explain(question, investigator, {
as? })` answers `read` (an object and each of its values), `relationship`
(a traversal and each related object), `invoke` (an Action with an input:
authorization, target, input, preconditions) and `query` (why it fails,
or which rows are not returned). `WorkflowEngine.explain(name,
investigator, { as? })` answers whether the subject may start a workflow,
approve each approval and invoke each Action, and what its AI steps may
be given.

**Replayed, not predicted.** The operation is run as the subject through
the runtime's own path, with nothing executed (an Action is previewed,
ADR-0053) and every value discarded. Each decision the runtime makes on
the way is kept: what its audit row records, plus the policy's name. A
finding is built from those decisions and says how it is known:
`evaluated` (decided now), `structural` (from the definitions) or
`observed` (an earlier decision from the audit log). Every explanation
carries the caveat that the runtime decides every call again.

**Disclosure follows the investigator.** An investigator explaining their
own access is told only what a refusal would tell them: the control that
decided (member policy, classification, derivation...) when discovery is
open, nothing about which control under need-to-know, and never a policy
name, rule or marking. Explaining anyone else's access needs the
inspection policy (ADR-0088); an inspector is told the policy, its rule,
the engine's reason, the markings they are cleared for, the source that
failed, a remedy drawn from the definitions, and the matching decisions
from the audit log.

**Nothing the investigator may not learn.** A Type, member or Action their
own discovery withholds is answered as unknown or left out. An inspector
explaining a read must be able to read the object themselves, decided as
their own read would be, so an explanation is never a way to learn
whether an object exists or what it holds. A relationship or query
explanation reports only related objects and rows the investigator is
returned, and counts nothing else.

**Honest audit, honest rate limits.** The subject's decisions during an
explanation are audited under operation `explain` with
`details.explainedBy`, and the explanation itself is audited for the
investigator. The investigator's rate limit is charged once; the
subject's is never charged for being investigated.

**Audiences are named.** A decision the subject's audience refused
(ADR-0067) is reported with control `audience`, so "the maintainer may
read it but the enclave model may not" is distinguished from a refusal of
the maintainer.

## Consequences

- "Why can the viewer not see this aircraft's maintenance status?" has a
  one-call answer: withheld by member policy `airforce.maintainer-only`,
  `role in [maintainer, ai-enclave]`, the viewer has `[viewer]`.
- The answer cannot disagree with the runtime, because it is the runtime's
  own decision. It can disagree with a later call, which the caveat says.
- An explanation runs the operation's reads, so it costs what the read
  costs.
- The audit log is read only to its newest 500 rows for `observed`, since
  `listAuditEvents` filters by action only. A deployment that needs
  deeper history queries its audit store.

## Amendment (5.0 pressure test, 2026-10-17)

The pressure test found the first version told an inspector more than
their own reads would. Each of these is now held by
`packages/domain-hospital/test/explain-disclosure.test.ts` and a
mutation:

- Explaining someone else counts related objects and rows only among
  those the investigator is returned themselves, and says so ("2 of the
  2 objects you are returned").
- A value the investigator may not read themselves is reported as
  `not-told`, never as returned or withheld to the subject. Dangling
  references are named only for a Type the investigator is told of, and
  whether the object exists is asked of its source before any policy
  that decides on its values.
- Every declared value's policy and marking is decided while
  explaining, whether or not the object holds a value, so a caller's own
  explanation never tells a withheld value from an absent one.
- Recorded decisions (`observed`) are listed only for values and objects
  the investigator is told of.
- A refused or failed explanation is audited with its subject, as an
  answered one is; the investigator's own reads during it are charged
  once; a malformed question is invalid input.
- A workflow explanation names an Action the caller is not told of only
  to an inspector, gives a caller the runtime's own masked reason under
  need-to-know, and is audited as `workflow.explain` with its subject.
  The subject's description and Actions it reads to answer are still
  recorded as that subject's own decisions.
