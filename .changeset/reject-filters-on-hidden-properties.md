---
"@typesys/core": patch
---

**Security fix:** `query` now rejects a top-level `filter` that references a property the caller can't read (per the Type's `x-policy.propertyPolicies`), throwing `AuthorizationError` and auditing a deny. Previously the adapter filtered on unredacted values, so a caller could learn a hidden property's value from which objects matched, even though the property itself was redacted from every result.
