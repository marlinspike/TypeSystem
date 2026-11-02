import type { Adapter, DomainManifest, Identity, PolicyRule, SemanticRuntimeOptions } from "@typesys/core";
import { corePack } from "@typesys/packs";
import { DEPLOYMENT_FORMAT, adapterForSource, buildHost, overlayEnvironment, type Deployment, type Host, type HostEnvironment, type HttpSourceSpec } from "@typesys/host";
import { inventorySource, sensorSource, trackerSource } from "./adapters.js";
import { coldChainPolicyDocument, INVENTORY, SENSORS, TRACKER } from "./model.js";
import { coldChainPack } from "./pack.js";
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
   * application adds to the cold chain in code. `adapters` is given the cold
   * chain's own, by data source; an adapter it returns with the same data
   * source replaces that one. Everything added is recorded as code on the
   * host (`host.code`), and declared in the deployment it builds.
   */
  readonly extend?: {
    readonly manifests?: readonly DomainManifest[];
    readonly policyRules?: Readonly<Record<string, PolicyRule>>;
    readonly adapters?: (base: Readonly<Record<string, Adapter>>) => readonly Adapter[] | Promise<readonly Adapter[]>;
  };
}

export type ColdChainHost = Host & { services?: RunningServices };

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

/** The cold chain's sources, by data source id. */
export const coldChainSources: Readonly<Record<string, HttpSourceSpec>> = { [TRACKER]: trackerSource, [SENSORS]: sensorSource, [INVENTORY]: inventorySource };

/**
 * The cold chain as a deployment (ADR-0102): no code at all. The model is
 * two packs, the three systems are declared with references to their
 * addresses and credentials, the rules are data, and the people are
 * personas with demonstration tokens. `deployments/cold-chain.deployment.json`
 * is this, written out by `npm run deployments`; the generic server runs it.
 */
export const coldChainDeployment: Deployment = {
  format: DEPLOYMENT_FORMAT,
  name: "cold-chain",
  description: "A pharmaceutical cold chain across a shipment tracker, a temperature sensor hub and a pharmacy inventory, each written and secured independently, behind one governed model.",
  demo: true,
  packs: [
    { name: "core", version: "1.0.0", digest: corePack.digest },
    { name: "coldchain", version: "1.0.0", digest: coldChainPack.digest }
  ],
  sources: coldChainSources,
  policies: coldChainPolicyDocument,
  classification: { kind: "linear", name: "coldchain-commercial", levels: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"] },
  identity: { kind: "tokens", tokens: { "demo-logistics-token": "logistics", "demo-qa-token": "qa", "demo-auditor-token": "auditor", "demo-carrier-token": "carrier" } },
  personas: {
    logistics: { subjectId: "user-logistics-1", roles: ["logistics"], attributes: { displayName: "Dana Whitfield" }, clearance: "INTERNAL" },
    qa: { subjectId: "user-qa-1", roles: ["qa"], attributes: { displayName: "Dr. Priya Raman" }, clearance: "CONFIDENTIAL" },
    auditor: { subjectId: "user-auditor-1", roles: ["auditor"], attributes: { displayName: "Sam Ortega" }, clearance: "INTERNAL" },
    carrier: { subjectId: "user-carrier-1", roles: ["carrier"], attributes: { displayName: "Northline dispatch", carrier: "Northline Cold Freight" }, clearance: "PUBLIC" },
    anonymous: { subjectId: "anonymous", roles: [], attributes: {} }
  },
  runtime: { callTimeoutMs: 2_000, inspectionPolicy: "coldchain.inspect" }
};

/** Where the in-process hosts find the services and which keys they hold: the given values first, then the process's environment. */
export function coldChainEnvironment(urls: NonNullable<ColdChainHostOptions["urls"]>, options: Pick<ColdChainHostOptions, "trackerKey" | "inventoryKey"> = {}): HostEnvironment {
  return overlayEnvironment({
    TYPESYS_COLDCHAIN_TRACKER_URL: urls.tracker,
    TYPESYS_COLDCHAIN_SENSORS_URL: urls.sensors,
    TYPESYS_COLDCHAIN_INVENTORY_URL: urls.inventory,
    TYPESYS_COLDCHAIN_TRACKER_KEY: options.trackerKey,
    TYPESYS_COLDCHAIN_INVENTORY_KEY: options.inventoryKey
  });
}

/** The name `extend` is recorded under: code an application adds in-process. */
export const APPLICATION_EXTENSION = "application";

/** The governed runtime over the three services: the generic host, built from `coldChainDeployment`. */
export async function buildColdChainHost(options: ColdChainHostOptions = {}): Promise<ColdChainHost> {
  const given = options.urls ?? coldChainUrlsFromEnv();
  const services = given ? undefined : await startServices();
  const urls = given ?? { tracker: services!.tracker.url, sensors: services!.sensors.url, inventory: services!.inventory.url };
  const env = coldChainEnvironment(urls, options);
  try {
    let deployment = coldChainDeployment;
    let added: readonly Adapter[] = [];
    if (options.extend?.adapters) {
      // The base adapters, as the host will build them, for the application to wrap; what it returns is declared below.
      const base = Object.fromEntries(Object.entries(coldChainSources).map(([id, spec]) => [id, adapterForSource(id, spec, env, true)]));
      added = await options.extend.adapters(base);
      const fresh = added.filter((a) => !Object.hasOwn(coldChainSources, a.dataSourceId));
      deployment = {
        ...coldChainDeployment,
        extensions: [APPLICATION_EXTENSION],
        sources: { ...coldChainSources, ...Object.fromEntries(fresh.map((a) => [a.dataSourceId, { kind: "extension" as const, extension: APPLICATION_EXTENSION }])) }
      };
    }
    const host = await buildHost(deployment, {
      packs: [corePack, coldChainPack],
      env,
      ...(options.extend?.adapters ? { extensions: [{ name: APPLICATION_EXTENSION, adapters: () => added }] } : {}),
      ...(options.extend?.manifests ? { manifests: options.extend.manifests } : {}),
      ...(options.extend?.policyRules ? { policyRules: options.extend.policyRules } : {}),
      ...(options.runtimeOptions ? { runtimeOptions: options.runtimeOptions } : {})
    });
    return Object.assign(host, services ? { services } : {});
  } catch (err) {
    await services?.stop();
    throw err;
  }
}

/** Demonstration identities: the deployment's personas. A real deployment resolves tokens with @typesys/auth-oidc (ADR-0050). */
export const coldChainIdentities = coldChainDeployment.personas as Record<"logistics" | "qa" | "auditor" | "carrier" | "anonymous", Identity>;

const TOKENS: Record<string, Identity> = {
  "demo-logistics-token": coldChainIdentities.logistics,
  "demo-qa-token": coldChainIdentities.qa,
  "demo-auditor-token": coldChainIdentities.auditor,
  "demo-carrier-token": coldChainIdentities.carrier
};

export function resolveColdChainIdentity(token: string | null | undefined): Promise<Identity> {
  return Promise.resolve(token && Object.hasOwn(TOKENS, token) ? TOKENS[token]! : coldChainIdentities.anonymous);
}
