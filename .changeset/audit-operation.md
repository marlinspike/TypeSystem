---
"@typesys/core": minor
"@typesys/registry-store-postgres": minor
---

Audit rows name the operation (ADR-0042). `AuditEvent` gains an optional `operation` — the outermost runtime call the row was written under (`getObject`, `getRelationship`, `getProvenance`, `query`, `aggregate`, `explainQuery`, `listActions`, `invokeAction`, exported as `RuntimeOperation`) — so a `listActions` preview is told apart from an `invokeAction` gate and a query's nested decisions from a direct read. `PostgresRegistryStore` persists it in a new nullable `operation` column (migration `0002_audit_operation.sql`).
