import {
  SemanticRegistry,
  InMemoryRegistryStore,
  SemanticRuntime,
  AbacPolicyEngine,
  requireRole,
  registerDomain,
  coreManifest,
  type Identity
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
  policyEngine: AbacPolicyEngine;
  inMemoryAdapter: InMemoryRepositoryAdapter;
  mockRestAdapter: MockRestAdapter;
}

/**
 * Builds a fully wired airforce testbed: registry with core + airforce
 * registered, two adapter styles seeded with sample data, and a policy
 * engine with the demo roles. Reused by domain-airforce's own tests and by
 * the MCP server's bootstrap — one source of truth for "how the slice is
 * assembled."
 */
export async function buildAirforceTestbed(): Promise<AirforceTestbed> {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registerDomain(registry, coreManifest);
  await registerDomain(registry, airforceManifest);

  const inMemoryAdapter = new InMemoryRepositoryAdapter(AIRCRAFT_DATA_SOURCE_ID, "airforce-repo");
  inMemoryAdapter.seed("airforce.Aircraft", sampleAircraft);
  inMemoryAdapter.seed("airforce.Component", sampleComponents);

  const mockRestClient = new MockRestClient(1);
  mockRestClient.seedMaintenanceEvents(sampleMaintenanceEvents);
  mockRestClient.seedWorkOrders(sampleWorkOrders);
  const mockRestAdapter = new MockRestAdapter(MAINTENANCE_DATA_SOURCE_ID, mockRestClient, {
    maintenanceEventType: "airforce.MaintenanceEvent",
    workOrderType: "airforce.WorkOrder"
  });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("airforce.read-aircraft", requireRole("maintainer", "viewer"));
  policyEngine.registerRule("airforce.maintainer-only", requireRole("maintainer"));

  const runtime = new SemanticRuntime(registry, [inMemoryAdapter, mockRestAdapter], policyEngine);

  return { registry, runtime, policyEngine, inMemoryAdapter, mockRestAdapter };
}

/** Canned demo identities for the vertical slice (see ADR-0009). */
export const demoIdentities: Record<"maintainer" | "viewer" | "anonymous", Identity> = {
  maintainer: { subjectId: "user-maintainer-1", roles: ["maintainer"], attributes: {} },
  viewer: { subjectId: "user-viewer-1", roles: ["viewer"], attributes: {} },
  anonymous: { subjectId: "anonymous", roles: [], attributes: {} }
};
