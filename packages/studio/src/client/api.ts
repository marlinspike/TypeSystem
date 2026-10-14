/**
 * The Studio's only way to the runtime: the governed API (ADR-0058) through
 * the typed SDK's HTTP transport, carrying the signed-in person's token. It
 * holds no authority of its own.
 */
import type { ModelDescription } from "@typesys/core";
import { httpCall, httpTransport, type Transport } from "@typesys/sdk";
import type { QueryDiagnostic } from "./logic.js";

export interface Me {
  readonly subjectId: string;
  readonly roles: readonly string[];
  readonly clearance?: string;
}

export interface StudioConfig {
  readonly title: string;
  readonly demo: readonly { readonly label: string; readonly token: string }[] | null;
}

export interface DiscoveryMatch {
  readonly kind: "type" | "action";
  readonly name: string;
  readonly score: number;
  readonly summary: string;
}

export interface StudioApi extends Transport {
  me(): Promise<Me>;
  model(): Promise<ModelDescription>;
  validate(query: unknown): Promise<QueryDiagnostic[]>;
  discover(task: string): Promise<DiscoveryMatch[]>;
}

export function studioApi(token: string | undefined, baseUrl = "/api"): StudioApi {
  const opts = { baseUrl, ...(token ? { token } : {}) };
  const call = httpCall(opts);
  return {
    ...httpTransport(opts),
    me: async () => (await call("GET", "/me")) as Me,
    model: async () => (await call("GET", "/model")) as ModelDescription,
    validate: async (query) => ((await call("POST", "/query/validate", { query })) as { diagnostics: QueryDiagnostic[] }).diagnostics,
    discover: async (task) => (await call("POST", "/discover", { task, limit: 8 })) as DiscoveryMatch[]
  };
}

export async function loadConfig(): Promise<StudioConfig> {
  const res = await fetch("/studio/config.json", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`The Studio's configuration did not load (HTTP ${res.status})`);
  return (await res.json()) as StudioConfig;
}
