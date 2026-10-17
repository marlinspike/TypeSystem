import { describeModel, type ModelDescription } from "@typesys/core";
import { buildAirforceTestbed } from "@typesys/domain-airforce";
import type { AppSpec } from "../src/ir.js";
import type { CheckEnvironment } from "../src/check.js";

let model: ModelDescription | undefined;

/** The Air Force model, as its author sees it. */
export async function airforceModel(): Promise<ModelDescription> {
  model ??= await describeModel((await buildAirforceTestbed()).registry);
  return model;
}

export async function airforceEnv(extra: Partial<CheckEnvironment> = {}): Promise<CheckEnvironment> {
  return { model: await airforceModel(), ...extra };
}

/**
 * A squadron maintenance application over the Air Force model that uses
 * every primitive once: the fixture each checker test breaks in one place.
 */
export function squadronApp(): AppSpec & Record<string, unknown> {
  return structuredClone({
    format: "typesys.app/1",
    name: "squadron-maintenance",
    title: "Squadron Maintenance",
    requirement: "A maintainer triages aircraft that need attention and opens work orders; a lead approves grounding an aircraft for repair.",
    host: { module: "@typesys/domain-airforce", build: "buildAirforceTestbed", identities: "resolveDemoIdentity" },
    callers: {
      maintainer: { token: "demo-maintainer-token" },
      lead: { token: "demo-lead-token" },
      viewer: { token: "demo-viewer-token" },
      anonymous: { token: "" }
    },
    llm: "typesys.llm.json",
    models: { triage: { id: "enclave" } },
    state: { selected: { schema: { type: ["string", "null"] }, default: null } },
    data: {
      attention: { kind: "query", query: { type: "airforce.Aircraft", filter: { property: "needsAttention", operator: "eq", value: true }, select: ["tailNumber", "model", "readinessStatus", "maintenanceStatus"], limit: 50 } }
    },
    flows: {
      ground: {
        name: "airforce.GroundAircraft",
        version: "1.0.0",
        startPolicy: "airforce.maintainer-only",
        input: { aircraftId: { schema: { type: "string", minLength: 1 }, objectOf: "airforce.Aircraft" } },
        steps: [
          { kind: "read", name: "aircraft", read: { kind: "object", type: "airforce.Aircraft", id: "$input.aircraftId" } },
          {
            kind: "parallel",
            name: "evidence",
            steps: [
              { kind: "read", name: "history", read: { kind: "related", of: "$aircraft.$id", type: "airforce.Aircraft", relationship: "maintenance" } },
              { kind: "read", name: "parts", read: { kind: "query", query: { type: "airforce.Component", filter: { property: "aircraftId", operator: "eq", value: "$input.aircraftId" } } } }
            ]
          },
          { kind: "compute", name: "poorParts", value: { count: { where: ["$parts", { eq: ["$item.condition", "poor"] }] } } },
          { kind: "check", name: "degraded", assert: { ne: ["$aircraft.maintenanceStatus", "operational"] }, message: "the aircraft is operational" },
          {
            kind: "ai",
            name: "triage",
            model: "triage",
            prompt: "Pick the maintenance event to work first.",
            input: { tail: "$aircraft.tailNumber", history: "$history", poorParts: "$poorParts" },
            output: { type: "object", properties: { eventId: { type: "string" }, priority: { type: "string", enum: ["routine", "urgent"] }, rationale: { type: "string" } }, required: ["eventId", "priority", "rationale"], additionalProperties: false }
          },
          { kind: "approval", name: "leadApproval", policy: "airforce.maintenance-lead", present: ["aircraft", "triage"] },
          {
            kind: "action",
            name: "open",
            action: "CreateMaintenanceWorkOrder",
            input: { maintenanceEventId: "$triage.eventId", assignedTo: "SSgt Rivera" },
            compensate: { action: "UpdateWorkOrderStatus", input: { workOrderId: "$output.id", status: "closed" } }
          }
        ]
      }
    },
    pages: [
      {
        name: "Board",
        title: "Aircraft needing attention",
        path: "/",
        data: { selectedAircraft: { kind: "object", type: "airforce.Aircraft", id: "$state.selected" } },
        layout: {
          kind: "grid",
          children: [
            { kind: "metric", id: "attention-count", label: "Needing attention", value: { count: "$attention" }, span: 3, tone: { if: [{ gt: [{ count: "$attention" }, 0] }, "warn", "good"] } },
            {
              kind: "table",
              id: "attention-table",
              data: "attention",
              span: 9,
              columns: ["tailNumber", "model", { field: "readinessStatus", format: "badge", tone: { FMC: "good", PMC: "warn", NMC: "bad" } }],
              select: "selected",
              rowActions: [{ label: "Ground", do: [{ run: "ground", input: { aircraftId: "$row.$id" } }] }]
            },
            { kind: "detail", id: "aircraft-detail", data: "selectedAircraft", fields: ["tailNumber", "model", "maintenanceStatus", "deploymentLocation"], provenance: true, when: { exists: "$state.selected" } },
            { kind: "approvals", id: "approvals" }
          ]
        }
      }
    ],
    acceptance: [
      { id: "viewer-lacks-status", kind: "reads", as: "viewer", type: "airforce.Aircraft", objectId: "AF86-0147", sees: ["tailNumber"], withheld: ["maintenanceStatus"] },
      { id: "anonymous-refused", kind: "refused", as: "anonymous", type: "airforce.Aircraft", objectId: "AF86-0147" },
      { id: "maintainer-grounds", kind: "starts", as: "maintainer", workflow: "airforce.GroundAircraft", input: { aircraftId: "AF86-0147" }, status: "waiting-approval", waitingOn: "leadApproval" },
      { id: "lead-approves", kind: "approves", as: "lead", startedBy: "maintainer", workflow: "airforce.GroundAircraft", input: { aircraftId: "AF86-0147" }, step: "leadApproval", admitted: true },
      { id: "board-shows-attention", kind: "screen", as: "maintainer", page: "Board", visible: ["attention-table"], rows: { "attention-table": { atLeast: 1 } } }
    ]
  }) as AppSpec & Record<string, unknown>;
}
