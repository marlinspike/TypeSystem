---
"@typesys/core": minor
---

A subtype keeps its base's protections (ADR-0060). Registration merges the base's property policies and classification markings into a subtype, and applies the base's object policy when the subtype names none. Before this, a subtype that named only an object policy exposed every protected value it inherited. A subtype may add a policy or marking but not replace an inherited one; one that tries is refused at registration.
