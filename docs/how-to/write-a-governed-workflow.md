# How to write a governed workflow

`@typesys/workflow` runs a declared sequence of steps through the runtime
as the person who started it, with approvals, retries, compensation and a
journal that survives restarts
([ADR-0057](../adr/0057-governed-workflows.md)). The worked example is
[`airforce.GroundForRepair`](../../packages/domain-airforce/src/workflows/ground-for-repair.ts).

## 1. Declare it

Type it by your generated model (see [use-the-typed-sdk.md](use-the-typed-sdk.md))
and the run's input:

```ts
import { defineWorkflow } from "@typesys/workflow";
import type { AirforceModel } from "@typesys/domain-airforce";

export const groundForRepair = defineWorkflow<AirforceModel, { aircraftId: string; assignTo: string }>({
  name: "airforce.GroundForRepair",       // qualified: policies name it as a resource
  version: "1.0.0",
  startPolicy: "airforce.maintainer-only",
  inputSchema: { type: "object", properties: { aircraftId: { type: "string" }, assignTo: { type: "string" } }, required: ["aircraftId", "assignTo"] },
  steps: [
    { kind: "read", name: "aircraft", run: (af, ctx) => af.get("airforce.Aircraft", ctx.input.aircraftId) },
    { kind: "compute", name: "flagged", needs: ["aircraft"], run: (ctx) => ctx.output<{ needsAttention?: boolean }>("aircraft")?.needsAttention === true },
    // ... an ai step, a compute step that checks its answer, an approval ...
    {
      kind: "action",
      name: "openWorkOrder",
      needs: ["proposal", "leadApproval"],
      action: "CreateMaintenanceWorkOrder",
      input: (ctx) => ({ maintenanceEventId: ctx.output<{ eventId: string }>("proposal")!.eventId, assignedTo: ctx.input.assignTo }),
      compensate: { action: "UpdateWorkOrderStatus", input: (_ctx, order) => ({ workOrderId: String(order.id), status: "closed" }) }
    }
  ]
});
```

The step kinds:

| Kind | Does | Recorded as |
|---|---|---|
| `read` | `run(client, ctx)` with the typed client, as the initiator | `read` |
| `compute` | `run(ctx)`, a pure function; re-run on replay and compared | `compute` |
| `ai` | sends `input(ctx)` and the fixed `prompt` to the engine's `AiModel`; the answer must match `outputSchema` | `model`, with the model's id |
| `approval` | waits until someone `policy` admits (not the initiator, unless `allowSelfApproval`) decides | `human` |
| `action` | invokes the Action with `input(ctx)` as the initiator; `compensate` undoes it if a later step fails | `action` |

Rules the engine holds you to:

- A step reads only the steps in its `needs` (`ctx.output(name)`) and the
  run's `ctx.input`; anything else fails the step. `needs` must name
  earlier steps.
- An Action with side effects whose `needs` lead back to an `ai` step needs
  an `approval` whose own `needs` lead back to that `ai` step too.
  Otherwise `register` refuses the workflow. Put deterministic checks of
  the model's answer in a compute step between them.
- `retry: { maxAttempts, backoffMs }` retries only errors marked retryable
  (timeouts, an unreachable source). It is refused on an Action whose
  idempotency is `none`. For an Action with idempotency `key`, pass
  `ctx.idempotencyKey`, which is the same on every attempt.
- `when(ctx)` skips a step (its output is `undefined`). It must be
  deterministic, like compute steps.

Add the policies the workflow names. Approvals and starts are decided with
action `invoke` on `{ typeName: "<workflow name>", actionName: "<step>" | "start" }`;
with Cedar, declare the workflow as an entity type and the policy as an
action that applies to it (see
[`demo-domains.cedarschema`](../../packages/policy-cedar/examples/demo-domains.cedarschema)).

## 2. Run it

```ts
import { WorkflowEngine } from "@typesys/workflow";

const engine = await WorkflowEngine.create({ host: { runtime, policyEngine, registry }, model: myModel, journal: myJournal });
engine.register(groundForRepair);

const run = await engine.start("airforce.GroundForRepair", { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" }, maintainer);
// run.status: "waiting-approval", run.waitingOn: { step: "leadApproval", policy: "airforce.maintenance-lead" }

await engine.pendingApproval(run.runId, lead);           // what the lead sees; refused for anyone the policy doesn't admit
await engine.approve(run.runId, "leadApproval", lead, { approved: true, comment: "Ground it." });
```

`status(runId)` shows where a run is with no values; `outputs(runId,
initiator)` returns its values to the initiator only; `trace(runId)` is
the journal. After a restart, `resume(runId)` or `resumeAll()` continue
from the journal. A run ends `completed`, `failed`, `rejected`, or
`needs-reconciliation`: a person must check the source system, because a
non-idempotent Action may or may not have run, or a compensation failed.

Pass `resolveIdentity` to look the initiator up again each time a run
advances, so a revoked role stops a waiting run at its next Action.

## 3. Simulate it before it runs

```ts
import { simulate } from "@typesys/workflow";

const { run, trace, refusals, crashes } = await simulate(host, groundForRepair, {
  initiator: maintainer,
  input: { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" },
  ai: { triage: { eventId: "EVT-9002", priority: "urgent", rationale: "Avionics fault." } },
  approvals: { leadApproval: { approver: lead, approved: true } },
  faults: { startWork: [{ attempt: 1, error: new AdapterUnavailableError("down") }] }
});
```

Reads are real; Actions are previewed and never invoked; the approver is
decided by the real policy. A fault can be an error or a crash
(`"before-effect"` or `"after-effect"`, also on `<step>.compensate`); after
a crash the simulation resumes from its journal. The trace is the journal.

## 4. Check a new version against recorded runs

```ts
import { replay } from "@typesys/workflow";

replay(newDefinition, runId, recordedJournal);   // throws ReplayDivergenceError naming the step
```

The engine runs the same check before it advances any run, so a definition
that no longer reproduces a run's history cannot continue it. Ship a
change in behavior as a new `version`: a run finishes on the version it
started on.

## Durability

The default journal is in memory and is lost on restart. For anything that
must survive one, use `@typesys/workflow-postgres` (ADR-0066):

```ts
import { PostgresWorkflowJournal, migrateWorkflowJournal } from "@typesys/workflow-postgres";

await migrateWorkflowJournal(pool);            // idempotent; safe from every replica
const engine = await WorkflowEngine.create({ host, model, journal: new PostgresWorkflowJournal(pool), resolveIdentity });
setInterval(() => void engine.tick(), 5_000);  // fires due approval deadlines and retry backoffs
```

Any other store can back a journal if it passes `workflowJournalContract`
(run it in your tests, as `packages/workflow/test/journal-contract.test.ts`
does). Temporal and DBOS bindings are designed, not built (ADR-0066). The
journal holds the initiator's identity and what the run read: protect it
like the audit log.

## Who a run acts as, over time

A run does not keep the permissions its initiator had when they started it
(ADR-0065). Before every step it re-resolves the initiator with your
`resolveIdentity` (or, without one, refuses an identity older than
`identityMaxAgeMs`, default 15 minutes), refuses one past its `expiresAt`,
and decides the workflow's `startPolicy` for them again. When any of those
fails the run is `suspended`, with nothing executed and the reason audited:

```ts
const run = await engine.status(runId);       // { status: "suspended", reason: "user-maintainer-1 is no longer admitted by ..." }
await engine.reauthorize(runId, freshIdentity); // the same subject, signed in again, still admitted
await engine.cancel(runId, lead, "reassigned"); // or undo what it completed; others need the workflow's cancelPolicy
```

Over HTTP, `POST /workflow-runs/:id/reauthorize` uses the caller's own
bearer identity, and `POST /workflow-runs/:id/cancel` takes a `reason`.
An approval may declare `deadline: { afterMs }`: undecided by then, it
expires and the run compensates as on a rejection.
