---
"@typesys/policy-cedar": minor
"@typesys/core": minor
---

Cedar planning (ADR-0039). `CedarPolicyEngine.plan()` uses Cedar's partial evaluation with the resource unknown and translates the residuals into an ADR-0038 `AuthorizationPlan`: equality on resource attributes becomes `eq` atoms, implied `has`/`!=` guards simplify away, `is` is decided against the queried Type, and every other shape is weakened to `true` — so the plan only ever admits more than Cedar allows. A possibly-erroring subterm or a non-trivial `forbid` costs exactness, and a Type with declared resource attributes is exact only with the new `schemaConformantData: true` option. Core gains the limitation codes `unrepresentable-condition`, `negated-condition`, and `unverified-attribute-types`; `checkPlanConformance` treats a throwing `evaluate` as a deny; and `anyOf` now treats an alternative that throws as one that doesn't allow, so a later alternative still can — which makes `always OR opaque` plan exactly in any order.
