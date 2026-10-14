# @typesys/workflow-postgres

The durable journal for `@typesys/workflow`
([ADR-0066](../../docs/adr/0066-durable-execution-on-the-journal-seam.md)).
Runs, approvals, durable timers and authority suspensions survive restarts,
and any number of processes may advance runs and call `tick()` against one
database: an append is conditional on the run's length, so exactly one
writer wins. Events are append-only, enforced by a trigger.

```ts
import { PostgresWorkflowJournal, migrateWorkflowJournal } from "@typesys/workflow-postgres";

await migrateWorkflowJournal(pool);
const engine = await WorkflowEngine.create({ host, model, journal: new PostgresWorkflowJournal(pool) });
```

Tested against real Postgres by the same contract the in-memory journal
passes (`workflowJournalContract`), plus crash recovery from two processes
at once. Tests skip without `DATABASE_URL` or `PGHOST`.
