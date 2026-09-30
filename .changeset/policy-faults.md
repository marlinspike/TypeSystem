---
"@typesys/core": minor
"@typesys/policy-cedar": minor
---

Policy faults are observable (ADR-0043). `PolicyDecision` gains `faults`: short, fixed descriptions of rule parts that failed to evaluate, carried whatever the decision is. `anyOf` reports a thrown alternative even when a later one allows, and both combinators pass on their children's faults. The runtime bounds an engine's faults (16 strings, 200 characters), records a top-level throw as one, audits them as `details.faults`, and counts them in the new `typesys.policy.faults` metric. `CedarPolicyEngine` reports policies that errored as faults.
