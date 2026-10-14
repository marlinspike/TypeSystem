import type {
  SemanticRegistry,
  SemanticRuntime,
  SemanticRuntimeOptions,
  PolicyRule
} from "@typesys/core";
import {
  allOf,
  anyOf,
  requireAttributeMatch,
  requireRole,
  buildRuntime,
  coreManifest,
  DEMO_LINEAR_CLASSIFICATION,
  type Audience,
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
  // `ai-enclave` is held only by a model audience (ADR-0067): the squadron's own enclave model may receive what a maintainer reads.
  "airforce.read-aircraft": requireRole("maintainer", "viewer", "ai-enclave"),
  "airforce.maintainer-only": requireRole("maintainer", "ai-enclave"),
  // Instance-scoped (ADR-0053): decided on the WorkOrder's own assignedTo.
  "airforce.work-order-assignee": allOf(requireRole("maintainer"), anyOf(requireRole("lead"), requireAttributeMatch("assignedTo", "displayName"))),
  // Who approves the GroundForRepair workflow's proposal (ADR-0057).
  "airforce.maintenance-lead": allOf(requireRole("maintainer"), requireRole("lead"))
};

/**
 * `runtimeOptions` (cache, rate limiter, concurrency, query limits) pass straight through to
 * `buildRuntime` — e.g. Redis-backed ones for a multi-instance run. `mockRestLatencyMs` sets the
 * simulated network latency of the maintenance system's REST calls (default 1ms), so a load test
 * can model a realistically slow backend.
 *
 * This domain marks `Aircraft.deploymentLocation` SECRET in the demo vocabulary, so the testbed
 * configures `DEMO_LINEAR_CLASSIFICATION` explicitly; without it the runtime's `DENY_MARKED_DATA`
 * default would hide the field from everyone (ADR-0034).
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
    runtimeOptions: { classification: DEMO_LINEAR_CLASSIFICATION, ...opts.runtimeOptions }
  });

  return { registry, runtime, policyEngine, inMemoryAdapter, mockRestAdapter };
}

/**
 * Canned demo identities for the vertical slice (see ADR-0009). The
 * maintainer is cleared SECRET and the viewer CUI, so the viewer reads an
 * Aircraft without its SECRET `deploymentLocation` (ADR-0032). The lead
 * approves workflows (ADR-0057) and may update any work order.
 */
export const demoIdentities: Record<"maintainer" | "lead" | "viewer" | "anonymous", Identity> = {
  maintainer: { subjectId: "user-maintainer-1", roles: ["maintainer"], attributes: { displayName: "SSgt Rivera" }, clearance: "SECRET" },
  lead: { subjectId: "user-lead-1", roles: ["maintainer", "lead"], attributes: { displayName: "MSgt Okafor" }, clearance: "SECRET" },
  viewer: { subjectId: "user-viewer-1", roles: ["viewer"], attributes: {}, clearance: "CUI" },
  anonymous: { subjectId: "anonymous", roles: [], attributes: {} }
};

/**
 * Two model audiences for the demo (ADR-0067). The enclave model runs inside
 * the squadron's accredited enclave, and policy grants it what a maintainer
 * reads, up to CUI: never the SECRET `deploymentLocation`. The commercial
 * model is an external API that policy grants nothing, so no Aircraft data
 * may be sent to it, whoever is asking.
 */
export const demoAudiences: Record<"enclaveModel" | "commercialModel", Audience> = {
  enclaveModel: { id: "model:squadron-enclave/triage", kind: "model", roles: ["ai-enclave"], attributes: { environment: "enclave", provider: "self-hosted" }, clearance: "CUI" },
  commercialModel: { id: "model:commercial-api/general", kind: "model", roles: [], attributes: { environment: "external", provider: "commercial" }, clearance: "UNCLASSIFIED" }
};

const DEMO_TOKENS: Record<string, Identity> = {
  "demo-maintainer-token": demoIdentities.maintainer,
  "demo-viewer-token": demoIdentities.viewer
};

/**
 * The demo's static bearer tokens (`demo-maintainer-token`, `demo-viewer-token`)
 * as an identity resolver, for the demo servers and their tests; anything else,
 * including no token, is `anonymous`. It has the shape of `@typesys/mcp-server`'s
 * `IdentityResolver` without importing it. Constants in source grant a role, so
 * this is for a demonstration, never a deployment (ADR-0050): a real one passes
 * `@typesys/auth-oidc`'s resolver.
 */
export async function resolveDemoIdentity(token: string | undefined | null): Promise<Identity> {
  // An own-property lookup: "constructor" and "__proto__" are not tokens.
  if (!token || !Object.hasOwn(DEMO_TOKENS, token)) return demoIdentities.anonymous;
  return DEMO_TOKENS[token]!;
}
