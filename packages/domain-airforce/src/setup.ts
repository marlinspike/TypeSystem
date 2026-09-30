import type {
  SemanticRegistry,
  SemanticRuntime,
  SemanticRuntimeOptions,
  PolicyRule
} from "@typesys/core";
import {
  requireRole,
  buildRuntime,
  coreManifest,
  type Identity,
  type PolicyEngine
} from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { MockRestAdapter, MockRestClient } from "@typesys/adapter-mock-rest";
import { airforceManifest } from "./manifest.js";
import { AIRCRAFT_DATA_SOURCE_ID, MAINTENANCE_DATA_SOURCE_ID } from "./types/aircraft.js";
import { sampleAircraft } from "./sample-data/aircraft.js";
import { sampleComponents } from "./sample-data/components.js";
import { sampleMaintenanceEvents } from "./sample-data/maintenance-events.js";
import { sampleWorkOrders } from "./sample-data/work-orders.js";

export interface AirforceTestbed {
  registry: SemanticRegistry;
  runtime: SemanticRuntime;
  policyEngine: PolicyEngine;
  inMemoryAdapter: InMemoryRepositoryAdapter;
  mockRestAdapter: MockRestAdapter;
}

/**
 * Builds a fully wired airforce testbed: registry with core + airforce
 * registered, two adapter styles seeded with sample data, and a policy
 * engine with the demo roles. Reused by domain-airforce's own tests and by
 * the MCP server's bootstrap — one source of truth for "how the slice is
 * assembled."
 *
 * The generic wiring (store → registry → register manifests → policy
 * engine → runtime) is `buildRuntime` (`@typesys/core`) — only what's
 * actually specific to this domain (which adapters, how they're seeded)
 * lives here now.
 */
/** This domain's named policy rules — exported so a runtime hosting several domains (the demo web app) can register them alongside others'. */
export const airforcePolicyRules: Record<string, PolicyRule> = {
  "airforce.read-aircraft": requireRole("maintainer", "viewer"),
  "airforce.maintainer-only": requireRole("maintainer")
};

/**
 * `runtimeOptions` (cache, rate limiter, concurrency, query limits) pass straight through to
 * `buildRuntime` — e.g. Redis-backed ones for a multi-instance run. `mockRestLatencyMs` sets the
 * simulated network latency of the maintenance system's REST calls (default 1ms), so a load test
 * can model a realistically slow backend.
 */
export async function buildAirforceTestbed(
  opts: { runtimeOptions?: SemanticRuntimeOptions; mockRestLatencyMs?: number } = {}
): Promise<AirforceTestbed> {
  const inMemoryAdapter = new InMemoryRepositoryAdapter(AIRCRAFT_DATA_SOURCE_ID, "airforce-repo");
  inMemoryAdapter.seed("airforce.Aircraft", sampleAircraft);
  inMemoryAdapter.seed("airforce.Component", sampleComponents);

  const mockRestClient = new MockRestClient(opts.mockRestLatencyMs ?? 1);
  mockRestClient.seedMaintenanceEvents(sampleMaintenanceEvents);
  mockRestClient.seedWorkOrders(sampleWorkOrders);
  const mockRestAdapter = new MockRestAdapter(MAINTENANCE_DATA_SOURCE_ID, mockRestClient, {
    maintenanceEventType: "airforce.MaintenanceEvent",
    workOrderType: "airforce.WorkOrder"
  });

  const { registry, runtime, policyEngine } = await buildRuntime({
    manifests: [coreManifest, airforceManifest],
    adapters: [inMemoryAdapter, mockRestAdapter],
    policyRules: airforcePolicyRules,
    runtimeOptions: opts.runtimeOptions
  });

  return { registry, runtime, policyEngine, inMemoryAdapter, mockRestAdapter };
}

/**
 * Canned demo identities for the vertical slice (see ADR-0009). The
 * maintainer is cleared SECRET and the viewer CUI, so the viewer reads an
 * Aircraft without its SECRET `deploymentLocation` (ADR-0032).
 */
export const demoIdentities: Record<"maintainer" | "viewer" | "anonymous", Identity> = {
  maintainer: { subjectId: "user-maintainer-1", roles: ["maintainer"], attributes: {}, clearance: "SECRET" },
  viewer: { subjectId: "user-viewer-1", roles: ["viewer"], attributes: {}, clearance: "CUI" },
  anonymous: { subjectId: "anonymous", roles: [], attributes: {} }
};
