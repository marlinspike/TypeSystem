---
"@typesys/workflow": minor
"@typesys/devkit": minor
"@typesys/domain-airforce": minor
---

Governed workflows (ADR-0057). New `@typesys/workflow`: `defineWorkflow` (read, compute, AI, approval and Action steps, typed by a generated model), `validateWorkflow` (an AI output may reach a side effect only through an approval of it), `WorkflowEngine` (runs as the initiator through the runtime; conditional journal; retries for retryable errors; compensation; policy-decided, four-eyes approvals; no repeat of a non-idempotent Action whose outcome was lost), `simulate` (previews, scripted model and approvers, fault and crash injection) and `replay`. Devkit adds `synthesize` and `synthesizeObjects`. The airforce domain adds the `airforce.GroundForRepair` workflow, the `airforce.maintenance-lead` rule (ABAC and Cedar) and a `lead` demo identity.
