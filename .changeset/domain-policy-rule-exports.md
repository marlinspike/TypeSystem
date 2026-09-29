---
"@typesys/domain-airforce": minor
"@typesys/domain-hospital": minor
---

Export each domain's named policy rules (`airforcePolicyRules`, `hospitalPolicyRules`), so a runtime hosting several domains can register them together without copying them. Each domain's own testbed uses the same exports.
