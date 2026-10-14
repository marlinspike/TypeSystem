---
"@typesys/http": minor
"@typesys/sdk": minor
"@typesys/workflow": minor
"@typesys/react": minor
"@typesys/studio": patch
---

A mission application, and what composing it from TypeSys changed (ADR-0063). `@typesys/http` adds `clientRouter`, which serves a bundled browser client and its configuration beside the governed API under `CLIENT_CSP` and the hardening headers (the Studio now uses it), and `GET /workflow-approvals`, every approval waiting on someone the caller may be. `@typesys/workflow` adds `WorkflowEngine.approvalsFor`, decided and audited per run as `pendingApproval` is. `@typesys/sdk` adds `httpWorkflows`, the workflow routes as a typed client. `@typesys/react` adds `dataOf` and `errorOf`, which read any `ResourceState`. The private `@typesys/mission-readiness` package holds the squadron readiness application written twice, composed and by hand, and `npm run mission` serves both; `scripts/compare-mission-apps.ts` measures them.
