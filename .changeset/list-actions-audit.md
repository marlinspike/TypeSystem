---
"@typesys/core": minor
"@typesys/policy-cedar": minor
---

`listActions` now audits the authorization decisions it reports (ADR-0030, ADR-0032). It shares one private gate with `invokeAction` — the Action's policy, then, only if that allows, the clearance its Types require — so a preview writes exactly the policy and classification rows an invocation's gates write; its `authorized` answers are unchanged. `@typesys/policy-cedar` also exports its `examples/` directory (`@typesys/policy-cedar/examples/*`), so applications can load the reference schema and policy set by package name.
