# 0043. Policy Faults Are Observable

## Status

Accepted — implemented in `@typesys/core` (`PolicyDecision.faults`; `anyOf`
and `allOf` in `policy/abac-policy-engine.ts`; bounding, auditing, and the
`typesys.policy.faults` counter in `runtime/runtime.ts`) and
`@typesys/policy-cedar` (errored policies as faults). Proven by
`packages/core/test/policy-faults.test.ts` — a thrown alternative reported
beside the allow that followed it and beside a deny; faults composing through
nested `allOf` and `anyOf`, including a denying branch's faults surviving a
later allow; an unevaluated alternative reporting nothing; no error message
ever carried; in the runtime, an **attack** where an allow reached around a
broken branch is audited per object inside a `query` with the fault and
without the thrown message, a top-level throw audited as a denied fault, and
an engine's faults bounded to 16 strings of 200 characters — and by
`packages/policy-cedar/test/cedar-policy-engine.test.ts`, the erroring
`forbid` reported as a fault.

Mutation-checked (11 mutations): dropping the thrown-alternative fault, the
allow's faults, either combinator's propagation of its children's, the
audit's `details.faults`, the runtime's allow-path faults, any of the three
bounds, the top-level-throw fault, or Cedar's — each fails the suites.

## Context

ADR-0039 changed `anyOf`: an alternative that throws no longer ends the OR —
it doesn't allow, and later alternatives are still tried. That is the right
semantics for a disjunction, and what makes `always OR opaque` plan exactly.
But it has a cost the old behavior didn't: a rule that throws on every
request can sit inside an `anyOf` for months, masked by an alternative that
allows, and nothing records it. A thrown branch is a policy defect — a bug,
a missing attribute, a shape the rule didn't expect — and the operator needs
to see it, whatever the final decision was.

## Decision

**1. `PolicyDecision.faults`.** An optional list of short, fixed
descriptions of the parts of a rule that failed to evaluate — never an
error message, which could quote an attribute value. It travels with the
decision *whatever* the decision is: an allow can carry faults.

**2. The combinators report every fault they see.** `anyOf` records
`anyOf alternative N failed to evaluate` for a branch that throws, and passes
on the faults of every branch it evaluated, including the one that allowed.
`allOf` passes on its children's faults and, as before, lets a throw deny
the whole conjunction. Nesting composes: the fault's text says where.

**3. The runtime keeps them, audits them, and counts them.** A top-level
engine that throws is itself a fault (`policy P failed to evaluate`). The
runtime keeps at most 16 fault strings of at most 200 characters from any
engine's answer, drops anything that isn't a string, writes them to the
audit row's `details.faults`, and counts them in `typesys.policy.faults`.
Cedar reports the policies that errored as faults, beside the deny it
already returns.

## Consequences

- An allow reached around a broken branch is visible in the audit log and
  in metrics, so a defect can't hide behind a later allow.
- Audit rows for decisions with faults gain `details.faults`.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **A custom engine's fault text is its own.** The runtime bounds and
  types it but can't tell whether a string quotes a value.

## Alternatives Considered

- **Keep the old `anyOf`, where a throw denied.** Fails closed, but makes
  `always OR opaque` unplannable exactly, and a throw in one branch says
  nothing about the others.
- **Log the error instead.** Logs are a wider exposure surface than the
  audit trail, and an error message can quote an attribute value.
- **Deny whenever any branch throws.** The old behavior, under another name.
