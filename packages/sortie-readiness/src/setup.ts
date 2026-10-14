import { buildRuntime, coreManifest, type BuiltRuntime, type Identity, type SemanticRuntimeOptions } from "@typesys/core";
import { depotAdapter, fleetAdapter, rosterAdapter } from "./adapters.js";
import { opsManifest, opsPolicyRules } from "./model.js";
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

export type SortieHost = BuiltRuntime & { services?: RunningServices };

/** The governed runtime over the three services (ADR-0072). */
export async function buildSortieHost(options: SortieHostOptions = {}): Promise<SortieHost> {
  const services = options.urls ? undefined : await startServices({ depotSchema: options.depotSchema ?? 1 });
  const urls = options.urls ?? { fleet: services!.fleet.url, depot: services!.depot.url, roster: services!.roster.url };
  const built = await buildRuntime({
    manifests: [coreManifest, opsManifest],
    adapters: [fleetAdapter(urls.fleet), depotAdapter(urls.depot, options.depotSchema ?? 1, options.depotKey), rosterAdapter(urls.roster, options.rosterPii ?? false)],
    policyRules: opsPolicyRules,
    runtimeOptions: { resilience: { callTimeoutMs: 2_000 }, ...options.runtimeOptions }
  });
  return { ...built, ...(services ? { services } : {}) };
}

/** Demonstration identities; a deployment resolves tokens with @typesys/auth-oidc (ADR-0050). */
export const sortieIdentities: Record<"planner" | "maintainer" | "viewer" | "anonymous", Identity> = {
  planner: { subjectId: "user-planner-1", roles: ["planner"], attributes: { displayName: "Maj Chen", unit: "388FW" } },
  maintainer: { subjectId: "user-maintainer-2", roles: ["maintainer"], attributes: { displayName: "TSgt Ruiz", unit: "388FW" } },
  viewer: { subjectId: "user-viewer-2", roles: ["viewer"], attributes: {} },
  anonymous: { subjectId: "anonymous", roles: [], attributes: {} }
};

const TOKENS: Record<string, Identity> = {
  "demo-planner-token": sortieIdentities.planner,
  "demo-maintainer-token": sortieIdentities.maintainer,
  "demo-viewer-token": sortieIdentities.viewer
};

export function resolveSortieIdentity(token: string | null | undefined): Promise<Identity> {
  return Promise.resolve(token && Object.hasOwn(TOKENS, token) ? TOKENS[token]! : sortieIdentities.anonymous);
}
