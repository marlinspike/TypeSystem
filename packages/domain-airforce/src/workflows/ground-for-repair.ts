import { defineWorkflow, type StepContext } from "@typesys/workflow";
import type { AirforceModel } from "../model.generated.js";

export interface GroundForRepairInput {
  readonly aircraftId: string;
  /** Who the work order is assigned to, as work orders record a maintainer (their display name). */
  readonly assignTo: string;
}

/** What the triage model must answer with. */
export interface TriageProposal {
  readonly eventId: string;
  readonly priority: "routine" | "urgent" | "grounding";
  readonly rationale: string;
}

const flagged = (ctx: StepContext<GroundForRepairInput>) => ctx.output<boolean>("flagged") === true;

/**
 * Ground an aircraft for repair (ADR-0057): the demonstration workflow, with
 * every step kind. It reads the aircraft and its maintenance history as the
 * maintainer who starts it, asks a model which event to act on, checks the
 * model's answer deterministically against what was read, has a maintenance
 * lead (someone else) approve it, opens the work order and starts it. If
 * starting fails, the work order is closed again. Nothing here is trusted
 * because a model said it: the work order is opened only for an event of this
 * aircraft, and only after a lead saw the proposal.
 */
export const groundForRepair = defineWorkflow<AirforceModel, GroundForRepairInput>({
  name: "airforce.GroundForRepair",
  version: "1.0.0",
  description: "Triage an aircraft that needs attention, and open and start a work order once a maintenance lead approves.",
  startPolicy: "airforce.maintainer-only",
  inputSchema: {
    type: "object",
    properties: { aircraftId: { type: "string", minLength: 1 }, assignTo: { type: "string", minLength: 1 } },
    required: ["aircraftId", "assignTo"],
    additionalProperties: false
  },
  steps: [
    {
      kind: "read",
      name: "aircraft",
      description: "The aircraft, as the initiator may read it.",
      retry: { maxAttempts: 3, backoffMs: 25 },
      run: async (af, ctx) => af.get("airforce.Aircraft", ctx.input.aircraftId)
    },
    {
      kind: "compute",
      name: "flagged",
      needs: ["aircraft"],
      run: (ctx) => ctx.output<{ needsAttention?: boolean }>("aircraft")?.needsAttention === true
    },
    {
      kind: "read",
      name: "history",
      needs: ["flagged"],
      when: flagged,
      retry: { maxAttempts: 3, backoffMs: 25 },
      run: async (af, ctx) =>
        (await af.related("airforce.Aircraft", ctx.input.aircraftId, "maintenance")).map((e) => ({
          id: e.$id,
          eventType: e.eventType,
          occurredAt: e.occurredAt,
          description: e.description
        }))
    },
    {
      kind: "ai",
      name: "triage",
      needs: ["flagged", "aircraft", "history"],
      when: flagged,
      prompt:
        "You are assisting an aircraft maintenance team. Given the aircraft and its maintenance history, choose the one maintenance event a work order should be opened for, its priority, and a one-sentence rationale.",
      input: (ctx) => {
        const aircraft = ctx.output<{ tailNumber?: string; model?: string; readinessStatus?: string }>("aircraft");
        return { aircraft: { tailNumber: aircraft?.tailNumber, model: aircraft?.model, readinessStatus: aircraft?.readinessStatus }, history: ctx.output("history") };
      },
      outputSchema: {
        type: "object",
        properties: {
          eventId: { type: "string" },
          priority: { enum: ["routine", "urgent", "grounding"] },
          rationale: { type: "string", maxLength: 500 }
        },
        required: ["eventId", "priority", "rationale"],
        additionalProperties: false
      }
    },
    {
      kind: "compute",
      name: "proposal",
      description: "The model's answer, checked against what was read: it must name an event of this aircraft.",
      needs: ["flagged", "history", "triage"],
      when: flagged,
      run: (ctx) => {
        const triage = ctx.output<TriageProposal>("triage")!;
        const event = ctx.output<{ id: string }[]>("history")?.find((e) => e.id === triage.eventId);
        if (!event) throw new Error(`The triage named event "${triage.eventId}", which is not in this aircraft's history`);
        return { ...triage, event };
      }
    },
    {
      kind: "approval",
      name: "leadApproval",
      description: "A maintenance lead, not the initiator, approves the proposal.",
      needs: ["flagged", "aircraft", "proposal"],
      when: flagged,
      policy: "airforce.maintenance-lead",
      present: (ctx) => ({
        tailNumber: ctx.output<{ tailNumber?: string }>("aircraft")?.tailNumber,
        readinessStatus: ctx.output<{ readinessStatus?: string }>("aircraft")?.readinessStatus,
        proposal: ctx.output("proposal")
      })
    },
    {
      kind: "action",
      name: "openWorkOrder",
      needs: ["flagged", "proposal", "leadApproval"],
      when: flagged,
      action: "CreateMaintenanceWorkOrder",
      input: (ctx) => ({ maintenanceEventId: ctx.output<TriageProposal>("proposal")!.eventId, assignedTo: ctx.input.assignTo }),
      compensate: { action: "UpdateWorkOrderStatus", input: (_ctx, workOrder) => ({ workOrderId: String(workOrder.id), status: "closed" as const }) }
    },
    {
      kind: "action",
      name: "startWork",
      needs: ["flagged", "openWorkOrder"],
      when: flagged,
      // Natural idempotency: setting a status twice leaves it set once.
      retry: { maxAttempts: 3, backoffMs: 25 },
      action: "UpdateWorkOrderStatus",
      input: (ctx) => ({ workOrderId: String(ctx.output<{ id?: string }>("openWorkOrder")?.id), status: "in-progress" as const })
    }
  ]
});

/** Every workflow this domain defines, for a host to register and for `typesys engineer plan` to report (ADR-0071). */
export const airforceWorkflows = [groundForRepair] as const;
