import type { Identity, SemanticRuntimeOptions } from "@typesys/core";
import { corePack } from "@typesys/packs";
import { DEPLOYMENT_FORMAT, buildHost, overlayEnvironment, type Deployment, type Host, type HostEnvironment } from "@typesys/host";
import { depotSource, fleetSource, rosterSource } from "./adapters.js";
import { DEPOT, FLEET, ROSTER, opsPolicyDocument } from "./model.js";
import { opsPack } from "./pack.js";
import { startServices, type RunningServices } from "./services.js";

export interface SortieHostOptions {
  /** The services' base URLs. When omitted, the three services are started here, each in its own process. */
  readonly urls?: { readonly fleet: string; readonly depot: string; readonly roster: string };
  readonly depotSchema?: 1 | 2;
  /** The depot key TypeSystem holds: `depot-hill-key` (KHIF only, the default) or `depot-hq-key` (every base). */
  readonly depotKey?: string;
  /** Whether TypeSystem's roster client holds the roster.pii scope. Default false: the roster never releases names. */
  readonly rosterPii?: boolean;
  readonly runtimeOptions?: SemanticRuntimeOptions;
}

export type SortieHost = Host & { services?: RunningServices };

/**
 * Sortie readiness as a deployment (ADR-0102): no code. `depotSchema`
 * picks the parts depot's mapping, and `rosterPii` the roster client that
 * holds the PII scope: an upgrade of either is a change to this document,
 * nothing else. `deployments/sortie-readiness.deployment.json` is the default.
 */
export function sortieDeployment(options: { readonly depotSchema?: 1 | 2; readonly rosterPii?: boolean } = {}): Deployment {
  return {
    format: DEPLOYMENT_FORMAT,
    name: "sortie-readiness",
    description: "Sortie readiness across a fleet registry, a parts depot and a crew roster, each written and secured independently, behind one governed model.",
    demo: true,
    packs: [
      { name: "core", version: "1.0.0", digest: corePack.digest },
      { name: "ops", version: "1.0.0", digest: opsPack.digest }
    ],
    sources: { [FLEET]: fleetSource, [DEPOT]: depotSource(options.depotSchema ?? 1), [ROSTER]: rosterSource(options.rosterPii ?? false) },
    policies: opsPolicyDocument,
    identity: { kind: "tokens", tokens: { "demo-planner-token": "planner", "demo-maintainer-token": "maintainer", "demo-viewer-token": "viewer" } },
    personas: {
      planner: { subjectId: "user-planner-1", roles: ["planner"], attributes: { displayName: "Maj Chen", unit: "388FW" } },
      maintainer: { subjectId: "user-maintainer-2", roles: ["maintainer"], attributes: { displayName: "TSgt Ruiz", unit: "388FW" } },
      viewer: { subjectId: "user-viewer-2", roles: ["viewer"], attributes: {} },
      anonymous: { subjectId: "anonymous", roles: [], attributes: {} }
    },
    runtime: { callTimeoutMs: 2_000 }
  };
}

/** Where an in-process host finds the services and which depot key it holds: the given values first, then the process's environment. */
export function sortieEnvironment(urls: NonNullable<SortieHostOptions["urls"]>, depotKey?: string): HostEnvironment {
  return overlayEnvironment({ TYPESYS_OPS_FLEET_URL: urls.fleet, TYPESYS_OPS_DEPOT_URL: urls.depot, TYPESYS_OPS_ROSTER_URL: urls.roster, TYPESYS_OPS_DEPOT_KEY: depotKey });
}

/** The governed runtime over the three services (ADR-0072): the generic host, built from `sortieDeployment`. */
export async function buildSortieHost(options: SortieHostOptions = {}): Promise<SortieHost> {
  const services = options.urls ? undefined : await startServices({ depotSchema: options.depotSchema ?? 1 });
  const urls = options.urls ?? { fleet: services!.fleet.url, depot: services!.depot.url, roster: services!.roster.url };
  try {
    const host = await buildHost(sortieDeployment({ ...(options.depotSchema ? { depotSchema: options.depotSchema } : {}), ...(options.rosterPii ? { rosterPii: true } : {}) }), {
      packs: [corePack, opsPack],
      env: sortieEnvironment(urls, options.depotKey),
      ...(options.runtimeOptions ? { runtimeOptions: options.runtimeOptions } : {})
    });
    return Object.assign(host, services ? { services } : {});
  } catch (err) {
    await services?.stop();
    throw err;
  }
}

/** Demonstration identities: the deployment's personas. A real deployment resolves tokens with @typesys/auth-oidc (ADR-0050). */
export const sortieIdentities = sortieDeployment().personas as Record<"planner" | "maintainer" | "viewer" | "anonymous", Identity>;

const TOKENS: Record<string, Identity> = {
  "demo-planner-token": sortieIdentities.planner,
  "demo-maintainer-token": sortieIdentities.maintainer,
  "demo-viewer-token": sortieIdentities.viewer
};

export function resolveSortieIdentity(token: string | null | undefined): Promise<Identity> {
  return Promise.resolve(token && Object.hasOwn(TOKENS, token) ? TOKENS[token]! : sortieIdentities.anonymous);
}
