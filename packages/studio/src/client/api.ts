/**
 * The Studio's only way to the runtime: the governed API (ADR-0058) through
 * the typed SDK's HTTP transport, carrying the signed-in person's token. It
 * holds no authority of its own.
 */
import type { ExplainQuestion, Explanation, ModelDescription, ModelInspection } from "@typesys/core";
import type { Baseline, ChangeImpact, GraphEdge, GraphNode, Reach, SemanticGraph } from "@typesys/devkit";
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

type GraphMeta = Pick<SemanticGraph, "format" | "structure" | "modelDigest" | "digest">;
/** A part of the graph: the overview, or one node's neighborhood. */
export interface GraphView extends GraphMeta {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly (GraphEdge & { readonly count?: number })[];
  readonly more: readonly string[];
  readonly counts?: Readonly<Record<string, number>>;
}
export type GraphReach = GraphMeta & Reach;

/** A workflow explanation (ADR-0089), as the engine returns it. */
export interface WorkflowExplanation {
  readonly workflow: string;
  readonly subject: string;
  readonly disclosure: "inspector" | "caller";
  readonly canStart: boolean;
  readonly findings: Explanation["findings"];
  readonly caveat: string;
}

export interface StudioApi extends Transport {
  me(): Promise<Me>;
  model(): Promise<ModelDescription>;
  validate(query: unknown): Promise<QueryDiagnostic[]>;
  discover(task: string): Promise<DiscoveryMatch[]>;
  /** The enforcement structure (ADR-0088); refused unless the caller may inspect. */
  inspection(types?: readonly string[]): Promise<ModelInspection>;
  /** Whose access the caller may explain; refused unless they may inspect. */
  subjects(): Promise<readonly { readonly subjectId: string; readonly label?: string }[]>;
  explainAccess(question: ExplainQuestion, as?: string): Promise<Explanation>;
  explainWorkflow(name: string, as?: string): Promise<WorkflowExplanation>;
  graph(view: "overview" | "full"): Promise<GraphView>;
  graph(view: "neighborhood", node: string, opts?: { depth?: number; limit?: number }): Promise<GraphView>;
  graph(view: "dependents" | "dependencies", node: string, opts?: { depth?: number }): Promise<GraphReach>;
  /** A baseline of the model as it is now (ADR-0093). */
  impactBaseline(): Promise<Baseline>;
  /** What changed since `baseline`. */
  impact(baseline: Baseline): Promise<ChangeImpact>;
}

export function studioApi(token: string | undefined, baseUrl = "/api"): StudioApi {
  const opts = { baseUrl, ...(token ? { token } : {}) };
  const call = httpCall(opts);
  return {
    ...httpTransport(opts),
    me: async () => (await call("GET", "/me")) as Me,
    model: async () => (await call("GET", "/model")) as ModelDescription,
    validate: async (query) => ((await call("POST", "/query/validate", { query })) as { diagnostics: QueryDiagnostic[] }).diagnostics,
    discover: async (task) => (await call("POST", "/discover", { task, limit: 8 })) as DiscoveryMatch[],
    inspection: async (types) => (await call("GET", `/inspection${types ? `?${types.map((t) => `type=${encodeURIComponent(t)}`).join("&")}` : ""}`)) as ModelInspection,
    subjects: async () => (await call("GET", "/subjects")) as { subjectId: string; label?: string }[],
    explainAccess: async (question, as) => (await call("POST", "/explain", { question, ...(as ? { as } : {}) })) as Explanation,
    explainWorkflow: async (name, as) => (await call("POST", `/workflows/${encodeURIComponent(name)}/explain`, as ? { as } : {})) as WorkflowExplanation,
    graph: (async (view: string, node?: string, opts: { depth?: number; limit?: number } = {}) => {
      const q = new URLSearchParams({ view, ...(node ? { node } : {}), ...(opts.depth ? { depth: String(opts.depth) } : {}), ...(opts.limit ? { limit: String(opts.limit) } : {}) });
      return call("GET", `/graph?${q.toString()}`);
    }) as StudioApi["graph"],
    impactBaseline: async () => (await call("GET", "/impact/baseline")) as Baseline,
    impact: async (baseline) => (await call("POST", "/impact", { baseline })) as ChangeImpact
  };
}

export async function loadConfig(): Promise<StudioConfig> {
  const res = await fetch("/studio/config.json", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`The Studio's configuration did not load (HTTP ${res.status})`);
  return (await res.json()) as StudioConfig;
}
