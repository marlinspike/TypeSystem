import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { MockRestAdapter, MockRestClient } from "@typesys/adapter-mock-rest";
import { DEMO_LINEAR_CLASSIFICATION, buildRuntime, coreManifest, type Identity, type PolicyEngine, type PolicyRule, type SemanticRegistry, type SemanticRuntime } from "@typesys/core";
import {
  AIRCRAFT_DATA_SOURCE_ID,
  MAINTENANCE_DATA_SOURCE_ID,
  airforceManifest,
  airforcePolicyRules,
  demoIdentities,
  groundForRepair,
  type TriageProposal
} from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel, type AiModel } from "@typesys/workflow";
import { missionFleet } from "./fleet.js";

export interface MissionBackend {
  readonly registry: SemanticRegistry;
  readonly runtime: SemanticRuntime;
  readonly policyEngine: PolicyEngine;
  readonly workflows: WorkflowEngine;
  /** The triage model both versions of the application ask. */
  readonly triage: AiModel;
}

/**
 * A stand-in for a language model in this demonstration: it proposes the
 * most recent maintenance event, urgent when the aircraft is not mission
 * capable. A deployment supplies a real model; nothing here trusts the
 * answer, which a lead approves before any work order is opened.
 */
export const triageModel: AiModel = scriptedModel(
  {
    triage: (request: { input: unknown }): TriageProposal => {
      const { aircraft, history } = request.input as { aircraft: { readinessStatus?: string }; history: { id: string; occurredAt?: string }[] };
      const latest = [...history].sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))[0];
      return {
        eventId: latest?.id ?? "none",
        priority: aircraft.readinessStatus === "NMC" ? "grounding" : "urgent",
        rationale: `Most recent event; aircraft is ${aircraft.readinessStatus ?? "of unknown readiness"}.`
      };
    }
  },
  "mission-demo-triage"
);

/**
 * The system both versions of the mission application run on: the airforce
 * domain over the mission fleet, with the maintenance system's reads
 * coalesced (ADR-0062), and the ground-for-repair workflow (ADR-0057).
 */
export interface MissionBackendOptions {
  /** Simulated latency of each call to the maintenance system. Default 0. */
  readonly maintenanceLatencyMs?: number;
  /** Replaces some of the airforce domain's policy rules, as a policy change would (the comparison's drift experiment). */
  readonly policyOverrides?: Readonly<Record<string, PolicyRule>>;
}

export async function buildMissionBackend(opts: MissionBackendOptions = {}): Promise<MissionBackend> {
  const fleet = missionFleet();
  const repo = new InMemoryRepositoryAdapter(AIRCRAFT_DATA_SOURCE_ID, "airforce-repo");
  repo.seed("airforce.Aircraft", fleet.aircraft);
  const client = new MockRestClient(opts.maintenanceLatencyMs ?? 0);
  client.seedMaintenanceEvents(fleet.events);
  client.seedWorkOrders(fleet.workOrders);
  const maintenance = new MockRestAdapter(MAINTENANCE_DATA_SOURCE_ID, client, { maintenanceEventType: "airforce.MaintenanceEvent", workOrderType: "airforce.WorkOrder" });
  const { registry, runtime, policyEngine } = await buildRuntime({
    manifests: [coreManifest, airforceManifest],
    adapters: [repo, maintenance],
    policyRules: { ...airforcePolicyRules, ...opts.policyOverrides },
    runtimeOptions: { classification: DEMO_LINEAR_CLASSIFICATION, computedReads: "coalesce" }
  });
  const workflows = await WorkflowEngine.create({ host: { registry, runtime, policyEngine }, model: triageModel });
  workflows.register(groundForRepair);
  return { registry, runtime, policyEngine, workflows, triage: triageModel };
}

/** The demonstration's sign-ins (ADR-0050): constants that grant a role, so never for a deployment. */
export const MISSION_TOKENS: Readonly<Record<string, Identity>> = {
  "mission-maintainer-token": demoIdentities.maintainer,
  "mission-lead-token": demoIdentities.lead,
  "mission-viewer-token": demoIdentities.viewer
};

/** The same tokens as the page offers them. */
export const MISSION_SIGN_INS = [
  { label: "Maintainer (SSgt Rivera)", token: "mission-maintainer-token" },
  { label: "Lead (MSgt Okafor)", token: "mission-lead-token" },
  { label: "Viewer", token: "mission-viewer-token" }
] as const;

export async function resolveMissionIdentity(token: string | null | undefined): Promise<Identity> {
  return token && Object.hasOwn(MISSION_TOKENS, token) ? MISSION_TOKENS[token]! : demoIdentities.anonymous;
}
