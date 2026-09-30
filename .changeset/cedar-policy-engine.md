---
"@typesys/policy-cedar": minor
---

New package: `CedarPolicyEngine` (ADR-0031), a drop-in `PolicyEngine` that runs the Cedar authorizer in-process via `@cedar-policy/cedar-wasm`. Each TypeS policy name maps to a Cedar action (`TypeS::Action::"<policyName>"`), the subject to a `TypeS::User` in its `TypeS::Role`s, and the resource to its Type's entity with only the attributes the Cedar schema declares. Policies are strictly validated against the schema at construction — any error or warning throws `CedarPolicyError`, and resource attributes must be optional so every policy guards them with `has` — and a decision allows only on a Cedar `allow` with no evaluation errors. Ships a reference schema and policy set for both demo domains (including the row-level own-patient rule) in `examples/`, proven to decide identically to `AbacPolicyEngine` by a parity suite.
