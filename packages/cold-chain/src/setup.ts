import { buildRuntime, coreManifest, type BuiltRuntime, type Identity, type SemanticRuntimeOptions } from "@typesys/core";
import { inventoryAdapter, sensorAdapter, trackerAdapter } from "./adapters.js";
import { coldChainClassification, coldChainManifest, coldChainPolicyRules } from "./model.js";
import { startServices, type RunningServices } from "./services.js";

export interface ColdChainHostOptions {
  /** The services' base URLs. When omitted, the three services are started here, each in its own process. */
  readonly urls?: { readonly tracker: string; readonly sensors: string; readonly inventory: string };
  /** The inventory key TypeSystem holds: `inventory-ops-key` (the default) or `inventory-readonly-key`, which may not write. */
  readonly inventoryKey?: string;
  /** The tracker key TypeSystem holds: `tracker-shipper-key` (every shipment, the default) or a carrier's own key. */
  readonly trackerKey?: string;
  readonly runtimeOptions?: SemanticRuntimeOptions;
}

export type ColdChainHost = BuiltRuntime & { services?: RunningServices };

/** The governed runtime over the three services. */
export async function buildColdChainHost(options: ColdChainHostOptions = {}): Promise<ColdChainHost> {
  const services = options.urls ? undefined : await startServices();
  const urls = options.urls ?? { tracker: services!.tracker.url, sensors: services!.sensors.url, inventory: services!.inventory.url };
  const built = await buildRuntime({
    manifests: [coreManifest, coldChainManifest],
    adapters: [trackerAdapter(urls.tracker, options.trackerKey), sensorAdapter(urls.sensors), inventoryAdapter(urls.inventory, options.inventoryKey)],
    policyRules: coldChainPolicyRules,
    runtimeOptions: { resilience: { callTimeoutMs: 2_000 }, classification: coldChainClassification, ...options.runtimeOptions }
  });
  return { ...built, ...(services ? { services } : {}) };
}

/** Demonstration identities; a deployment resolves tokens with @typesys/auth-oidc (ADR-0050). */
export const coldChainIdentities: Record<"logistics" | "qa" | "auditor" | "carrier" | "anonymous", Identity> = {
  logistics: { subjectId: "user-logistics-1", roles: ["logistics"], attributes: { displayName: "Dana Whitfield" }, clearance: "INTERNAL" },
  qa: { subjectId: "user-qa-1", roles: ["qa"], attributes: { displayName: "Dr. Priya Raman" }, clearance: "CONFIDENTIAL" },
  auditor: { subjectId: "user-auditor-1", roles: ["auditor"], attributes: { displayName: "Sam Ortega" }, clearance: "INTERNAL" },
  carrier: { subjectId: "user-carrier-1", roles: ["carrier"], attributes: { displayName: "Northline dispatch", carrier: "Northline Cold Freight" }, clearance: "PUBLIC" },
  anonymous: { subjectId: "anonymous", roles: [], attributes: {} }
};

const TOKENS: Record<string, Identity> = {
  "demo-logistics-token": coldChainIdentities.logistics,
  "demo-qa-token": coldChainIdentities.qa,
  "demo-auditor-token": coldChainIdentities.auditor,
  "demo-carrier-token": coldChainIdentities.carrier
};

export function resolveColdChainIdentity(token: string | null | undefined): Promise<Identity> {
  return Promise.resolve(token && Object.hasOwn(TOKENS, token) ? TOKENS[token]! : coldChainIdentities.anonymous);
}
