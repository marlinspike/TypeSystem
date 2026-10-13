# @typesys/workflow

Governed workflows over TypeS
([ADR-0057](../../docs/adr/0057-governed-workflows.md)): read, compute, AI,
approval and Action steps, run as the person who started them, with a
journal, retries, compensation and replay checks.

```ts
import { WorkflowEngine } from "@typesys/workflow";
import { groundForRepair } from "@typesys/domain-airforce";

const engine = await WorkflowEngine.create({ host: { runtime, policyEngine, registry }, model, journal });
engine.register(groundForRepair);                  // refused if an AI answer could reach a side effect unreviewed

const run = await engine.start("airforce.GroundForRepair", { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" }, maintainer);
run.status;                                        // "waiting-approval"
await engine.pendingApproval(run.runId, lead);     // what the lead is shown, if the policy admits them
await engine.approve(run.runId, "leadApproval", lead, { approved: true });
```

`simulate(host, workflow, script)` runs the same definition with Actions
previewed, model answers and approvals scripted, and faults injected;
`replay(workflow, runId, journal)` checks a definition against a recorded
run. The engine decides nothing the runtime decides: every read and Action
is the initiator's, through `SemanticRuntime`. The reference journal is in
memory; a durable journal, or a Temporal or DBOS binding, goes behind
`WorkflowJournal`.

See [`docs/how-to/write-a-governed-workflow.md`](../../docs/how-to/write-a-governed-workflow.md).
