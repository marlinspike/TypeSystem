---
"@typesys/core": minor
"@typesys/registry-store-postgres": patch
"@typesys/domain-airforce": minor
---

Derived values inherit their inputs' read policy (ADR-0052): a computed property is withheld from a caller who may not read every property it depends on, unless the Type lists that input in the computed property's new `releases`; each withholding and each release is audited with `details.control === "derivation"`. `ctx.getProperty` returns `undefined` for a declared input with no value instead of throwing. The airforce viewer no longer reads `readinessStatus`; `needsAttention` is released from `maintenanceStatus` explicitly.
