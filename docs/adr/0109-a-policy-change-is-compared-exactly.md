# 0109. A Policy Change Is Compared Exactly

## Status

Accepted (2026-11-03). Implemented in `packages/core/src/policy/policy-diff.ts`
(`comparePolicies`, `describeWitness`) and used by `packages/host/src/check.ts`.
Proven by `packages/core/test/policy-diff.test.ts` and
`packages/host/test/check.test.ts`. Addresses the open "formal analysis"
item of `docs/PRODUCTION-READINESS.md` item 1 for rules held as data.

## Context

`typesys deploy check` (ADR-0104) compared policy decisions for the
personas a deployment declares, and reads of a few probed objects. A rule
widened to a role no persona holds, or to an attribute value no probed
object has, passed. Since ADR-0100 rules are a small closed language with no
negation, so the question "does the new rule admit anyone the old one
refused" can be answered for every request.

## Decision

The new expression is written in disjunctive normal form over its atoms
(a role, a resource attribute equal to a subject attribute, a resource
attribute equal to a literal, type level allowed). For each conjunction, the
smallest request satisfying it is built: only its roles, only the attributes
it needs, attributes it equates sharing a fresh value no expression names,
contradictory conjunctions skipped; once at instance level and once at type
level where the conjunction allows it. Both rules are then decided on that
request by the compiled rules themselves. Because the old rule is monotone
in its atoms and the smallest request makes true only what the conjunction
forces, the old rule refusing it is a real widening, and the old rule
admitting it means it admits everything the conjunction covers: the result
is exact, with a witness for each widening. An expression with more than
4,096 conjunctions is reported as too large, still compared by personas, and
blocks the upgrade when the rule decides anything: a change that cannot be
compared is not known not to widen.

`deploy check` compares every rule changed or added in place, and every
Type, property or Action that now names another rule, and blocks each
widening where the rule decides something in the new build.

## Consequences

Adding a `contractor` role to a maintainer-only rule is blocked although no
persona is a contractor. The analysis covers rules held as data; a rule given
as code, Cedar policies, classification schemes and which Type names which
rule inside a pack are still compared by probes and inspection. AWS's Cedar
analysis (`cedar-policy-symcc`) remains the route for deployments on the
Cedar engine, which the deployment format does not offer.
