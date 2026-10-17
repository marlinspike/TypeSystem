# 0088. An Authorized Developer May Inspect the Enforcement Structure

## Status

Accepted (2026-10-17). Builds on ADR-0056 (the model as a consumer sees
it), ADR-0068 (discovery authorization) and ADR-0032 (classification).
Implemented in `packages/core/src/runtime/inspection.ts`,
`SemanticRuntime.inspectModel`, `PolicyEngine.describe` (ABAC in
`packages/core/src/policy/abac-policy-engine.ts`, Cedar in
`packages/policy-cedar/src/cedar-policy-engine.ts`). Proven by
`packages/domain-airforce/test/inspect-explain.test.ts`,
`packages/core/test/policy-describe.test.ts` and
`packages/policy-cedar/test/cedar-policy-engine.test.ts`.

## Context

`ModelDescription` is the consumer contract: Types, values, relationships
and Actions, deliberately with nothing about enforcement. That is right
for an application, and wrong for the person who maintains the model or
debugs a refusal. To learn that `Aircraft.maintenanceStatus` comes from
the `Maintainable` trait, is stored in the airforce repository and is
guarded by `airforce.maintainer-only`, which admits `role in
[maintainer, ai-enclave]`, a developer today reads four TypeScript files.
A coding agent reconstructs the same from source, and may get it wrong.

The structure itself is sensitive. Policy rules say who is trusted with
what, marking names can be classified (ADR-0032), and source
configuration holds credentials. So it cannot simply be added to the
description every caller receives.

## Decision

**A governed inspection.** `runtime.inspectModel(identity, { types? })`
returns `typesys.inspection/1`: for each Type, its object policy, markings
and source; for each member, where it came from (own, a trait, the base
Type), its schema, its source mapping (and whether a per-property
override moves it to another source), its member policy, its markings,
and for a computed value its inputs, releases, binding and declared
source reads; for each relationship, its source and whether it crosses
sources; for each Action, its policy, preconditions, the source and
operation its effect lands in, side effects, idempotency and audit; the
sources by id, name and kind, and whether an adapter serves each; and each
policy with the Types, members or Actions it decides and its rule as the
engine describes it.

**Deny by default, decided by the engine.** A runtime inspects only when
configured with `inspection: { policy }`. The named policy is decided like
any other, with action `read` on `{ typeName: "*", actionName:
"inspect-model" }`, for the person and for the audience they read for
(ADR-0067), and audited. With no inspection configured, nobody may
inspect, and an anonymous caller never may.

**Never wider than discovery.** The inspection is built from the model as
`describeModel` describes it to the inspector. Under need-to-know, a Type,
member, Action or policy they may not learn of is neither described nor
counted (a count would say that it exists). A marking is named only to an
inspector cleared for it; otherwise the member says how many markings it
carries that they may not learn. Source configuration is never included.

**Policy structure from the engine.** `PolicyEngine.describe(policyName)`
is optional. The ABAC combinators describe themselves from the arguments
they were built with (`all of (role in [maintainer]; any of (role in
[lead]; resource.assignedTo = subject.displayName))`); a plain function
rule is reported as opaque. The Cedar engine returns the policies whose
action scope names the policy (or names no action), as written. A
description never contains a decision or anything about a subject.

**Declared source reads for computed values.** `x-computed.reads` lists
the sources a computation reads directly through `ctx.getAdapter`
(`Aircraft.needsAttention` reads the maintenance system). When declared,
the runtime refuses any other source the computation asks for, so the
lineage the inspection reports is enforced, not asserted. Undeclared, the
inspection says `reads: "undeclared"`. The airforce domain now declares
it.

**A digest of what was shown.** `modelDigest` is the sha256 of the
inspection's content. Two inspections by the same inspector of the same
model are byte-identical, and the digest never changes because something
withheld from the inspector changed.

## Consequences

- A developer or a coding agent can learn the whole enforcement structure
  of what they work on in one call instead of reading the domain's source.
- Inspection is a privilege a deployment grants, and the grant is audited.
  The demo grants it to the lead.
- A computed value that reads a source it does not declare keeps working;
  one that declares its reads is held to them.
- Not addressed: the history of a policy's text (an engine describes what
  is registered now), and source configuration, which stays with the
  deployment.
