---
"@typesys/core": minor
"@typesys/domain-airforce": minor
"@typesys/auth-oidc": minor
---

Data classification enforcement (ADR-0032): `Identity.clearance` must dominate a Type's `x-provenance.defaultClassification`, a member's new `x-provenance.properties[name].classification`, and a value's `ProvenanceRef.classification`, under a pluggable `ClassificationScheme` (`SemanticRuntimeOptions.classification`; default `US_CLASSIFICATION` = `linearClassification(["UNCLASSIFIED", "CUI", "SECRET", "TOP_SECRET"])`, with missing or unknown clearances holding only the lowest level and unknown markings readable by no one). Enforced at `SemanticRuntime` beside the policy engine on every read path: a classified object is refused before any adapter call (`query` returns an empty page), values are redacted with their provenance, computed properties inherit their dependencies' markings, filter/sort/search/aggregate probes on marked properties are refused, Actions on classified Types are refused, and every check on marked data is audited with `details.control === "classification"`. `@typesys/auth-oidc` gains `clearanceClaim`. The airforce demo's `Aircraft.deploymentLocation` is SECRET; the demo maintainer is cleared SECRET and the viewer CUI.
