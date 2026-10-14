---
"@typesys/core": minor
"@typesys/workflow": minor
"@typesys/workflow-postgres": minor
"@typesys/packs": minor
"@typesys/mcp-server": patch
"@typesys/http": patch
"@typesys/cli": patch
"@typesys/registry-store-postgres": minor
---

Fixes from the independent review of the M2 security foundations
(docs/reviews/m2-adversarial-review.md). Workflows keep the audience a run
reads for, refuse outputs to a different one, and decide `when` conditions
again for the model. Cancelling an unrecorded Action ends
`needs-reconciliation`. Sweeps isolate each run, and deadlines and engine
limits are validated. Previews follow discovery, and descriptions never name
a withheld base Type, inverse or successor. REST withholds refusal reasons
outside open discovery, and a caller reading for a model gets one refusal
reason. Co-signatures bind earlier signers, revocation applies to the key,
installs are recorded and checked, and every install is audited. The
Postgres journal refuses TRUNCATE, keeps its runs table consistent with its
events, and stores NUL. `listAuditEvents` takes an `action` filter.
