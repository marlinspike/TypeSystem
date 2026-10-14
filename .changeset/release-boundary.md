---
"@typesys/core": minor
"@typesys/workflow": minor
"@typesys/domain-airforce": minor
---

Release to models is decided for the model (ADR-0067). New `Audience` and `Identity.audience`: with one bound, the runtime allows a decision only when the person and the audience are both allowed, for policy, classification and row-level planning, and audits the audience. `bindAudience` binds the model behind an MCP or HTTP agent; `withAudience`, `audienceIdentity` and `decideForIdentity` are new. Workflow AI steps send their model only what its audience may receive (`AiModel.audience`, `release: "redact"`, `ReleaseRefusedError`); an AI step fed by an Action is refused. The airforce demo adds `demoAudiences` and grants its enclave model the `ai-enclave` role.
