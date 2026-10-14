---
"@typesys/workflow": minor
"@typesys/workflow-postgres": minor
"@typesys/core": minor
"@typesys/auth-oidc": minor
"@typesys/http": minor
"@typesys/sdk": minor
---

Workflows act on continuing authority (ADR-0065): the initiator is re-resolved, expiry and the start policy are decided again before every step, and a refusal suspends the run until `reauthorize` or `cancel` (`cancelPolicy` admits someone else). Approvals may set a `deadline`; retry backoffs are durable timers; `tick()` fires them. `Identity.expiresAt` is new, set by the OIDC resolver from `exp`. New `@typesys/workflow-postgres`: a durable, append-only journal (ADR-0066), and `workflowJournalContract` for any other. HTTP adds `POST /workflow-runs/:id/reauthorize` and `/cancel`; the SDK's workflow client adds `reauthorize` and `cancel`.
