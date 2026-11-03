# 0100. Policy Rules Are Data

## Status

Accepted (2026-11-02). First step of the deployment design
(`/mnt/project-files/reviews/deployment-design-pressure-test.md`, finding
H2: "governance is code"). Implemented in
`packages/core/src/policy/policy-document.ts` (`compilePolicy`,
`compilePolicies`, `validatePolicyExpression`),
`packages/core/src/policy/abac-policy-engine.ts` (`requireResourceValue`)
and `packages/core/src/testing/policy-parity.ts` (`comparePolicyRules`).
Proven by `packages/core/test/policy-document.test.ts` and a parity test in
every package that ships rules.

## Context

Every shipped rule set was TypeScript: `requireRole`, `requireAttributeMatch`,
`anyOf` and `allOf` composed in code, and one hand-written function (the
recall exchange's public-notice rule). A rule that is code cannot be held in
a deployment file, reviewed as a diff, compared between two builds, or
changed without a new image. That defeats a deployment that is upgraded by
replacing a declared document.

## Decision

A rule is a JSON value naming the combinator it is:
`"always"`, `{ "role": [...] }`, `{ "attributeMatch": { "resource", "subject" } }`,
`{ "resourceValue": { "attribute", "equals", "typeLevel"?, "reason"? } }`,
`{ "anyOf": [...] }`, `{ "allOf": [...] }`. `compilePolicy` builds it with the
combinators themselves, so decisions, deny reasons, authorization plans
(ADR-0038), structural assurance (ADR-0046) and descriptions are exactly the
code's. Validation names every problem at once with its path, refuses
unknown fields, and caps nesting at 32 levels so a hostile document cannot
exhaust the stack.

`requireResourceValue` is the one new combinator: strict equality on the
resource's own attribute (never an inherited one), a type-level answer the
rule declares (`allow` when some instances may be readable, `deny`
otherwise), a predicate plan for an identifier and an
`unrepresentable-condition` limitation for anything else, and a deny reason
that never quotes the value. It replaces the hand-written recall rule.

Every shipped rule set (airforce, hospital, cold chain, recalls, sortie
readiness) is now a `PolicyDocument`, and each package's `xPolicyRules` is
`compilePolicies(xPolicyDocument)`. `comparePolicyRules` proves each
rewritten set decides, reasons, plans and describes exactly as the code it
replaced, over every persona and resource the tests name.

## Consequences

A deployment holds its rules (ADR-0102), and the upgrade check compares two
rule sets as data and as decisions (ADR-0104). A rule that needs more than
these forms (a time window, a lookup) is still code: an extension can supply
it as a code rule, which the host records under `code.policies` and never
lets shadow a declared rule. Cedar policies (`@typesys/policy-cedar`) are
unchanged and remain the choice for richer conditions.
