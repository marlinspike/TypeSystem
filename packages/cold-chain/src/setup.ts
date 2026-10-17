import { buildRuntime, coreManifest, type Adapter, type BuiltRuntime, type DomainManifest, type Identity, type PolicyRule, type SemanticRuntimeOptions } from "@typesys/core";
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
  /**
   * More of the model over more systems, on the same runtime: what an
   * application adds to the cold chain (the recall exchange is one).
   * `adapters` is given the cold chain's own, by data source; an adapter it
   * returns with the same data source replaces that one.
   */
  readonly extend?: {
    readonly manifests?: readonly DomainManifest[];
    readonly policyRules?: Readonly<Record<string, PolicyRule>>;
    readonly adapters?: (base: Readonly<Record<string, Adapter>>) => readonly Adapter[] | Promise<readonly Adapter[]>;
  };
}

export type ColdChainHost = BuiltRuntime & { services?: RunningServices };

/**
 * The services' URLs from `TYPESYS_COLDCHAIN_TRACKER_URL`, `_SENSORS_URL` and
 * `_INVENTORY_URL`, when all three are set: how the showcase points several
 * processes (the application, Studio) at one running copy of each service.
 */
export function coldChainUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): ColdChainHostOptions["urls"] {
  const tracker = env.TYPESYS_COLDCHAIN_TRACKER_URL;
  const sensors = env.TYPESYS_COLDCHAIN_SENSORS_URL;
  const inventory = env.TYPESYS_COLDCHAIN_INVENTORY_URL;
  return tracker && sensors && inventory ? { tracker, sensors, inventory } : undefined;
}

/** The governed runtime over the three services. */
export async function buildColdChainHost(options: ColdChainHostOptions = {}): Promise<ColdChainHost> {
  const given = options.urls ?? coldChainUrlsFromEnv();
  const services = given ? undefined : await startServices();
  const urls = given ?? { tracker: services!.tracker.url, sensors: services!.sensors.url, inventory: services!.inventory.url };
  const base: Record<string, Adapter> = Object.fromEntries(
    [trackerAdapter(urls.tracker, options.trackerKey), sensorAdapter(urls.sensors), inventoryAdapter(urls.inventory, options.inventoryKey)].map((a) => [a.dataSourceId, a])
  );
  const extra = (await options.extend?.adapters?.(base)) ?? [];
  const adapters = new Map<string, Adapter>(Object.entries(base));
  for (const a of extra) adapters.set(a.dataSourceId, a);
  const built = await buildRuntime({
    manifests: [coreManifest, coldChainManifest, ...(options.extend?.manifests ?? [])],
    adapters: [...adapters.values()],
    policyRules: { ...coldChainPolicyRules, ...options.extend?.policyRules },
    runtimeOptions: { resilience: { callTimeoutMs: 2_000 }, classification: coldChainClassification, inspection: { policy: "coldchain.inspect" }, ...options.runtimeOptions }
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
