import { createHash } from "node:crypto";
import { canonical, type Identity, type ModelDescription, type ModelInspection, type SemanticRuntime } from "@typesys/core";

export const GRAPH_FORMAT = "typesys.graph/1";

/**
 * What a node stands for (ADR-0090). `part` is one piece of a consumer: a
 * workflow step, an application's page, data, flow step or acceptance check.
 */
export type GraphNodeKind = "type" | "member" | "relationship" | "action" | "source" | "policy" | "marking" | "workflow" | "app" | "part";

export interface GraphNode {
  /** `type:airforce.Aircraft`, `member:airforce.Aircraft.needsAttention`, `part:workflow:airforce.GroundForRepair/approve`. */
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  /** The node it belongs to: a member's Type, a step's workflow, a flow's application. */
  readonly parent?: string;
  /** Kind-specific facts: a member's `stored`/`computed`, a policy's rule, a part's kind. */
  readonly detail?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  /**
   * A consumer names it and the model does not describe it to whoever built
   * the graph: it does not exist, or it is withheld from them. The two are
   * deliberately not told apart (ADR-0068).
   */
  readonly unresolved?: true;
}

/**
 * Every edge reads "`from` depends on `to`": a computed value derives from
 * its inputs, a member reads from a source, a step uses a Type. So the
 * dependents of a node are found against the edges and its dependencies
 * along them.
 */
export type GraphEdgeKind =
  | "extends"
  | "reads-from"
  | "writes-to"
  | "guarded-by"
  | "marked"
  | "derives-from"
  | "released-from"
  | "targets"
  | "applies-to"
  | "returns"
  | "uses";

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: GraphEdgeKind;
  /**
   * `declared`: stated by a definition the runtime enforces or a consumer's
   * own specification. `inferred`: concluded by this graph from something
   * weaker, such as a read that names no members and so may read any.
   */
  readonly basis: "declared" | "inferred";
  /** How it is used: `query`, `filter`, `invoke`, `approval`, `start`, `column`, `sees`. */
  readonly how?: string;
  /** A use of a whole Type (a query with no `select`, a relationship's objects): it depends on every member. */
  readonly whole?: true;
}

/** What a consumer uses: a Type, member, relationship, Action or policy of the model, or another part of itself. */
export type GraphUse = { readonly how: string; readonly basis?: "declared" | "inferred" } & (
  | { readonly kind: "type"; readonly type: string; readonly whole?: boolean }
  | { readonly kind: "member"; readonly type: string; readonly member: string }
  | { readonly kind: "relationship"; readonly type: string; readonly relationship: string }
  | { readonly kind: "action"; readonly action: string }
  | { readonly kind: "policy"; readonly policy: string }
  | { readonly kind: "part"; readonly part: string }
  | { readonly kind: "consumer"; readonly consumer: "workflow" | "app"; readonly name: string }
);

export interface ConsumerPart {
  /** Unique in its consumer. */
  readonly name: string;
  /** `read`, `action`, `approval`, `ai`, `page`, `data`, `check`... */
  readonly kind: string;
  readonly label?: string;
  readonly uses: readonly GraphUse[];
  /** Why this part's uses may be incomplete: a read step that declares nothing reads through an opaque function. */
  readonly opaque?: string;
}

/**
 * Something built on the model: a workflow (`workflowUses` in
 * `@typesys/workflow`) or an application (`appUses` in `@typesys/compiler`).
 * The graph takes them as data, so it depends on neither package.
 */
export interface GraphConsumer {
  readonly kind: "workflow" | "app";
  readonly name: string;
  readonly version?: string;
  /** For an application's flow: the application it belongs to. */
  readonly within?: string;
  readonly uses: readonly GraphUse[];
  readonly parts: readonly ConsumerPart[];
}

export interface SemanticGraph {
  readonly format: typeof GRAPH_FORMAT;
  /**
   * `inspection`: built from an inspection (ADR-0088), so sources, policies
   * and markings are present. `description`: built from what `describeModel`
   * tells the caller, so the enforcement structure is withheld.
   */
  readonly structure: "inspection" | "description";
  /** The inspection's own digest, or sha256 of the description: which model this graph describes. */
  readonly modelDigest: string;
  /** sha256 of the nodes and edges: two graphs with one digest are the same graph. */
  readonly digest: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export const nodeId = {
  type: (t: string) => `type:${t}`,
  member: (t: string, m: string) => `member:${t}.${m}`,
  relationship: (t: string, r: string) => `relationship:${t}.${r}`,
  action: (a: string) => `action:${a}`,
  source: (s: string) => `source:${s}`,
  policy: (p: string) => `policy:${p}`,
  marking: (m: string) => `marking:${m}`,
  consumer: (kind: "workflow" | "app", name: string) => `${kind}:${name}`,
  part: (consumer: string, part: string) => `part:${consumer}/${part}`
};

const isInspection = (m: ModelInspection | ModelDescription): m is ModelInspection => m.format === "typesys.inspection/1";
const sha256 = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

class Builder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  node(n: GraphNode): string {
    const had = this.nodes.get(n.id);
    // A real definition replaces a placeholder a consumer's use made first.
    if (!had || (had.unresolved && !n.unresolved)) this.nodes.set(n.id, n);
    return n.id;
  }

  edge(e: GraphEdge): void {
    const key = `${e.from}|${e.kind}|${e.to}|${e.how ?? ""}`;
    if (!this.edges.has(key)) this.edges.set(key, e);
  }

  /** The node a use names, a placeholder when the model does not describe it. */
  target(use: GraphUse, consumerId: string): string {
    switch (use.kind) {
      case "type":
        return this.node({ id: nodeId.type(use.type), kind: "type", label: use.type, unresolved: true });
      case "member":
        this.target({ kind: "type", type: use.type, how: use.how }, consumerId);
        return this.node({ id: nodeId.member(use.type, use.member), kind: "member", label: use.member, parent: nodeId.type(use.type), unresolved: true });
      case "relationship":
        this.target({ kind: "type", type: use.type, how: use.how }, consumerId);
        return this.node({ id: nodeId.relationship(use.type, use.relationship), kind: "relationship", label: use.relationship, parent: nodeId.type(use.type), unresolved: true });
      case "action":
        return this.node({ id: nodeId.action(use.action), kind: "action", label: use.action, unresolved: true });
      case "policy":
        return this.node({ id: nodeId.policy(use.policy), kind: "policy", label: use.policy, unresolved: true });
      case "part":
        return this.node({ id: nodeId.part(consumerId, use.part), kind: "part", label: use.part, parent: consumerId, unresolved: true });
      case "consumer":
        return this.node({ id: nodeId.consumer(use.consumer, use.name), kind: use.consumer, label: use.name, unresolved: true });
    }
  }
}

/**
 * A part that reads two whole Types, one related to the other, may follow
 * the relationship between them: a read step's declared reads must name
 * the Types it follows a relationship to (ADR-0090), so this is how it
 * says so. The edge is inferred, since it may read both without following.
 */
function inferFollowed(b: Builder): void {
  const whole = new Map<string, Set<string>>();
  for (const e of b.edges.values()) if (e.whole && e.kind === "uses") (whole.get(e.from) ?? whole.set(e.from, new Set()).get(e.from)!).add(e.to);
  const relationships = [...b.edges.values()].filter((e) => e.kind === "targets" && e.whole && b.nodes.get(e.from)?.kind === "relationship");
  for (const [part, types] of whole)
    for (const r of relationships) {
      const parent = b.nodes.get(r.from)!.parent;
      if (parent && types.has(parent) && types.has(r.to)) b.edge({ from: part, to: r.from, kind: "uses", basis: "inferred", how: "follows" });
    }
}

/** Removes the placeholder mark from nodes a later definition made real, and drops placeholders for Types a member placeholder implied when the member was real. */
function settle(b: Builder): void {
  for (const n of b.nodes.values()) if (n.unresolved && n.parent && !b.nodes.has(n.parent)) b.node({ id: n.parent, kind: "type", label: n.parent.slice(5), unresolved: true });
}

function addModel(b: Builder, model: ModelInspection | ModelDescription): void {
  if (isInspection(model)) {
    for (const s of model.sources) b.node({ id: nodeId.source(s.id), kind: "source", label: s.name ?? s.id, detail: { connected: s.connected, ...(s.kind ? { sourceKind: s.kind } : {}) } });
    for (const p of model.policies) b.node({ id: nodeId.policy(p.name), kind: "policy", label: p.name, detail: { opaque: p.opaque, ...(p.rule ? { rule: p.rule } : {}) } });
    const guard = (from: string, policy: string | undefined, how: string) => {
      if (!policy) return;
      b.node({ id: nodeId.policy(policy), kind: "policy", label: policy, detail: { opaque: true } });
      b.edge({ from, to: nodeId.policy(policy), kind: "guarded-by", basis: "declared", how });
    };
    const mark = (from: string, markings: readonly string[]) => {
      for (const m of markings) {
        b.node({ id: nodeId.marking(m), kind: "marking", label: m });
        b.edge({ from, to: nodeId.marking(m), kind: "marked", basis: "declared" });
      }
    };
    const source = (from: string, dataSourceId: string, how: string) => {
      b.node({ id: nodeId.source(dataSourceId), kind: "source", label: dataSourceId, detail: { connected: false } });
      b.edge({ from, to: nodeId.source(dataSourceId), kind: "reads-from", basis: "declared", how });
    };
    for (const t of model.types) {
      const tid = b.node({ id: nodeId.type(t.name), kind: "type", label: t.name, detail: { version: t.version, ...(t.deprecated ? { deprecated: true } : {}) } });
      if (t.extends) b.edge({ from: tid, to: nodeId.type(t.extends), kind: "extends", basis: "declared" });
      guard(tid, t.objectPolicy, "object");
      mark(tid, t.markings);
      if (t.source) source(tid, t.source.dataSourceId, t.source.operation);
      for (const m of t.members) {
        const mid = b.node({ id: nodeId.member(t.name, m.name), kind: "member", label: m.name, parent: tid, detail: { member: m.kind, required: m.required, origin: m.origin.from } });
        guard(mid, m.policy, "member");
        mark(mid, m.markings);
        if (m.source) source(mid, m.source.dataSourceId, m.source.operation);
        if (m.computed) {
          for (const d of m.computed.dependsOn) b.edge({ from: mid, to: nodeId.member(t.name, d), kind: "derives-from", basis: "declared" });
          for (const r of m.computed.releases) b.edge({ from: mid, to: nodeId.member(t.name, r), kind: "released-from", basis: "declared" });
          if (m.computed.reads !== "undeclared") for (const s of m.computed.reads) source(mid, s, "computation");
        }
      }
      for (const r of t.relationships) {
        const rid = b.node({ id: nodeId.relationship(t.name, r.name), kind: "relationship", label: r.name, parent: tid, detail: { cardinality: r.cardinality, optional: r.optional, crossSource: r.crossSource } });
        b.edge({ from: rid, to: nodeId.type(r.target), kind: "targets", basis: "declared", whole: true });
        guard(rid, r.policy, "relationship");
        mark(rid, r.markings);
        source(rid, r.source.dataSourceId, r.source.operation);
      }
    }
    for (const a of model.actions) {
      const aid = b.node({ id: nodeId.action(a.name), kind: "action", label: a.name, detail: { version: a.version, sideEffects: a.sideEffects, idempotency: a.idempotency } });
      for (const t of a.applicableTypes) b.edge({ from: aid, to: nodeId.type(t), kind: "applies-to", basis: "declared" });
      if (a.target) b.edge({ from: aid, to: nodeId.type(a.target.type), kind: "targets", basis: "declared", how: a.target.idFrom });
      if (a.outputType) b.edge({ from: aid, to: nodeId.type(a.outputType), kind: "returns", basis: "declared" });
      guard(aid, a.policy, "invoke");
      mark(aid, a.markings);
      b.node({ id: nodeId.source(a.implementation.dataSourceId), kind: "source", label: a.implementation.dataSourceId, detail: { connected: false } });
      b.edge({ from: aid, to: nodeId.source(a.implementation.dataSourceId), kind: "writes-to", basis: "declared", how: a.implementation.operation });
    }
    return;
  }
  for (const t of model.types) {
    const tid = b.node({ id: nodeId.type(t.name), kind: "type", label: t.name, detail: { version: t.version, ...(t.deprecated ? { deprecated: true } : {}) } });
    if (t.extends) b.edge({ from: tid, to: nodeId.type(t.extends), kind: "extends", basis: "declared" });
    for (const p of Object.keys(t.properties)) b.node({ id: nodeId.member(t.name, p), kind: "member", label: p, parent: tid, detail: { member: "stored", required: t.required.includes(p) } });
    for (const c of t.computed) {
      const mid = b.node({ id: nodeId.member(t.name, c.name), kind: "member", label: c.name, parent: tid, detail: { member: "computed", required: false } });
      for (const d of c.dependsOn) b.edge({ from: mid, to: nodeId.member(t.name, d), kind: "derives-from", basis: "declared" });
    }
    for (const r of t.relationships) {
      const rid = b.node({ id: nodeId.relationship(t.name, r.name), kind: "relationship", label: r.name, parent: tid, detail: { cardinality: r.cardinality, optional: r.optional ?? false } });
      b.edge({ from: rid, to: nodeId.type(r.target), kind: "targets", basis: "declared", whole: true });
    }
  }
  for (const a of model.actions) {
    const aid = b.node({ id: nodeId.action(a.name), kind: "action", label: a.name, detail: { version: a.version, sideEffects: a.sideEffects, idempotency: a.idempotency } });
    for (const t of a.applicableTypes) b.edge({ from: aid, to: nodeId.type(t), kind: "applies-to", basis: "declared" });
    if (a.target) b.edge({ from: aid, to: nodeId.type(a.target.type), kind: "targets", basis: "declared", how: a.target.idFrom });
  }
}

function addUses(b: Builder, from: string, consumerId: string, uses: readonly GraphUse[], governance: boolean): void {
  for (const use of uses) {
    // A description withholds the enforcement structure, so a consumer's policies are left out with it.
    if (use.kind === "policy" && !governance) continue;
    const to = b.target(use, consumerId);
    b.edge({ from, to, kind: use.kind === "policy" ? "guarded-by" : "uses", basis: use.basis ?? "declared", how: use.how, ...(use.kind === "type" && use.whole ? { whole: true as const } : {}) });
  }
}

export interface GraphOptions {
  /**
   * `drop` leaves out every node a consumer names that the model does not
   * describe, with the edges to it. A host serving the graph to a caller
   * under need-to-know discovery drops them, since a consumer's
   * specification can name what that caller may not learn of (ADR-0068).
   * Default `keep`.
   */
  readonly unresolved?: "keep" | "drop";
}

/**
 * One dependency graph over the model, its sources, policies and markings,
 * and the workflows and applications built on it (ADR-0090). It is built
 * from what its builder may learn: an inspection gives the enforcement
 * structure, a description gives the contract only. It decides nothing.
 */
export function semanticGraph(model: ModelInspection | ModelDescription, consumers: readonly GraphConsumer[] = [], opts: GraphOptions = {}): SemanticGraph {
  const b = new Builder();
  addModel(b, model);
  for (const c of consumers) {
    const cid = b.node({
      id: nodeId.consumer(c.kind, c.name),
      kind: c.kind,
      label: c.name,
      ...(c.within ? { parent: nodeId.consumer("app", c.within) } : {}),
      ...(c.version ? { detail: { version: c.version } } : {})
    });
    if (c.within) b.node({ id: nodeId.consumer("app", c.within), kind: "app", label: c.within, unresolved: true });
    addUses(b, cid, cid, c.uses, isInspection(model));
    for (const p of c.parts) {
      const pid = b.node({
        id: nodeId.part(cid, p.name),
        kind: "part",
        label: p.label ?? p.name,
        parent: cid,
        detail: { part: p.kind, ...(p.opaque ? { opaque: p.opaque } : {}) }
      });
      addUses(b, pid, cid, p.uses, isInspection(model));
    }
  }
  inferFollowed(b);
  settle(b);
  const dropped = new Set(opts.unresolved === "drop" ? [...b.nodes.values()].filter((n) => n.unresolved && n.kind !== "part" && n.kind !== "workflow" && n.kind !== "app").map((n) => n.id) : []);
  const nodes = [...b.nodes.values()].filter((n) => !dropped.has(n.id)).sort((x, y) => x.id.localeCompare(y.id));
  // An edge to something the model does not describe (a value a computation names but the caller is not told of, a Type withheld) goes nowhere, and is left out.
  const edges = [...b.edges.values()].filter((e) => !dropped.has(e.from) && !dropped.has(e.to) && b.nodes.has(e.from) && b.nodes.has(e.to)).sort((x, y) => `${x.from}|${x.kind}|${x.to}|${x.how ?? ""}`.localeCompare(`${y.from}|${y.kind}|${y.to}|${y.how ?? ""}`));
  return {
    format: GRAPH_FORMAT,
    structure: isInspection(model) ? "inspection" : "description",
    modelDigest: isInspection(model) ? model.modelDigest : sha256(model),
    digest: sha256({ nodes, edges }),
    nodes,
    edges
  };
}

/**
 * The graph as one caller may learn it, the same for every host (HTTP, MCP,
 * CLI): from an inspection when the runtime lets them inspect, else from
 * their description; and, unless discovery is open, without the names a
 * consumer uses that their description leaves out.
 */
export async function governedGraph(runtime: Pick<SemanticRuntime, "canInspect" | "inspectModel" | "describeModel" | "discovery">, identity: Identity, consumers: readonly GraphConsumer[] = []): Promise<SemanticGraph> {
  const model = (await runtime.canInspect(identity)) ? await runtime.inspectModel(identity) : await runtime.describeModel(identity);
  return semanticGraph(model, consumers, { unresolved: runtime.discovery === "open" ? "keep" : "drop" });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface GraphIndex {
  readonly graph: SemanticGraph;
  node(id: string): GraphNode | undefined;
  children(id: string): readonly GraphNode[];
  out(id: string): readonly GraphEdge[];
  in(id: string): readonly GraphEdge[];
}

const indexes = new WeakMap<SemanticGraph, GraphIndex>();

/** Lookups by node, cached per graph. */
export function indexGraph(graph: SemanticGraph): GraphIndex {
  const cached = indexes.get(graph);
  if (cached) return cached;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, GraphNode[]>();
  const outs = new Map<string, GraphEdge[]>();
  const ins = new Map<string, GraphEdge[]>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const n of graph.nodes) if (n.parent) push(kids, n.parent, n);
  for (const e of graph.edges) {
    push(outs, e.from, e);
    push(ins, e.to, e);
  }
  const index: GraphIndex = {
    graph,
    node: (id) => byId.get(id),
    children: (id) => kids.get(id) ?? [],
    out: (id) => outs.get(id) ?? [],
    in: (id) => ins.get(id) ?? []
  };
  indexes.set(graph, index);
  return index;
}

/** The node and everything it contains: a Type's members and relationships, a consumer's parts and flows. */
function withDescendants(ix: GraphIndex, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n);
    for (const c of ix.children(n)) stack.push(c.id);
  }
  return out;
}

/** The workflow or application that holds a node, outermost last. */
function consumersOf(ix: GraphIndex, id: string): string[] {
  const out: string[] = [];
  for (let n = ix.node(id); n; n = n.parent ? ix.node(n.parent) : undefined) if (n.kind === "workflow" || n.kind === "app") out.push(n.id);
  return out;
}

/**
 * Whether a node is an application's acceptance check (`appUses`' `check.<id>`
 * parts), not a workflow's own `check` step, which runs inside the workflow
 * and is not something to run after a change.
 */
export function isAcceptanceCheck(graph: SemanticGraph, id: string): boolean {
  const ix = indexGraph(graph);
  const node = ix.node(id);
  return node?.kind === "part" && node.detail?.part === "check" && node.parent !== undefined && ix.node(node.parent)?.kind === "app";
}

export interface Reached {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  /** Hops from the subject. */
  readonly distance: number;
  /** The edge that reached it. */
  readonly via: GraphEdgeKind;
  readonly how?: string;
  /** `inferred` when any edge on the way was. */
  readonly basis: "declared" | "inferred";
  /** Node ids from the subject to it. */
  readonly path: readonly string[];
}

export interface Reach {
  readonly subject: string;
  /** In order of distance, then id. */
  readonly reached: readonly Reached[];
  /** The workflows and applications any reached node belongs to. */
  readonly consumers: readonly string[];
  /** Reached parts whose uses may be incomplete, so the answer may be too. */
  readonly opaque: readonly string[];
}

function walkGraph(graph: SemanticGraph, subject: string, direction: "dependents" | "dependencies", maxDepth: number): Reach {
  const ix = indexGraph(graph);
  if (!ix.node(subject)) throw new Error(`no node ${subject} in the graph`);
  const start = withDescendants(ix, subject);
  const seen = new Map<string, Reached>();
  const startSet = new Set(start);
  let frontier: { id: string; path: string[]; basis: "declared" | "inferred" }[] = start.map((id) => ({ id, path: [id], basis: "declared" as const }));
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      const edges: { edge: GraphEdge; to: string }[] =
        direction === "dependents" ? ix.in(f.id).map((edge) => ({ edge, to: edge.from })) : ix.out(f.id).map((edge) => ({ edge, to: edge.to }));
      const n = ix.node(f.id);
      // A use of a whole Type reads every member of it, not the relationships it could go on to follow:
      // what depends on the Type that way depends on each member.
      if (direction === "dependents" && n?.parent && n.kind === "member") for (const edge of ix.in(n.parent)) if (edge.whole) edges.push({ edge, to: edge.from });
      for (const { edge, to } of edges) {
        const reach = direction === "dependencies" && edge.whole ? [to, ...ix.children(to).filter((c) => c.kind === "member").map((c) => c.id)] : [to];
        for (const id of reach) {
          if (startSet.has(id) || seen.has(id)) continue;
          const node = ix.node(id)!;
          const basis = f.basis === "inferred" || edge.basis === "inferred" ? "inferred" : "declared";
          const path = [...f.path, id];
          seen.set(id, { id, kind: node.kind, label: node.label, distance: depth, via: edge.kind, ...(edge.how ? { how: edge.how } : {}), basis, path });
          next.push({ id, path, basis });
        }
      }
    }
    frontier = next;
  }
  const reached = [...seen.values()].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const consumers = [...new Set(reached.flatMap((r) => consumersOf(ix, r.id)))].sort();
  const opaque = reached.filter((r) => ix.node(r.id)?.detail?.opaque !== undefined).map((r) => r.id);
  return { subject, reached, consumers, opaque };
}

/** Everything that depends on a node, or on anything it contains, transitively: what a change to it can reach. */
export function dependents(graph: SemanticGraph, id: string, opts: { depth?: number } = {}): Reach {
  return walkGraph(graph, id, "dependents", opts.depth ?? Number.POSITIVE_INFINITY);
}

/** Everything a node, or anything it contains, depends on, transitively: what it rests on. */
export function dependencies(graph: SemanticGraph, id: string, opts: { depth?: number } = {}): Reach {
  return walkGraph(graph, id, "dependencies", opts.depth ?? Number.POSITIVE_INFINITY);
}

export interface Subgraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Nodes in the result that have neighbors left out: what to expand next. */
  readonly more: readonly string[];
}

/**
 * The nodes within `depth` hops of a node, by edges in either direction and
 * by containment, at most `limit` of them, nearest first: what a workbench
 * shows when someone opens one node of a large model.
 */
export function neighborhood(graph: SemanticGraph, id: string, opts: { depth?: number; limit?: number; kinds?: readonly GraphNodeKind[] } = {}): Subgraph {
  const ix = indexGraph(graph);
  if (!ix.node(id)) throw new Error(`no node ${id} in the graph`);
  const depth = opts.depth ?? 1;
  const limit = opts.limit ?? 60;
  const allowed = (n: GraphNode) => n.id === id || !opts.kinds || opts.kinds.includes(n.kind);
  const neighbors = (n: string): string[] => {
    const node = ix.node(n)!;
    return [...ix.out(n).map((e) => e.to), ...ix.in(n).map((e) => e.from), ...ix.children(n).map((c) => c.id), ...(node.parent ? [node.parent] : [])].sort();
  };
  const keep = new Set([id]);
  let frontier = [id];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const n of frontier)
      for (const m of neighbors(n)) {
        if (keep.size >= limit) break;
        if (keep.has(m) || !allowed(ix.node(m)!)) continue;
        keep.add(m);
        next.push(m);
      }
    frontier = next;
  }
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  const more = nodes.filter((n) => neighbors(n.id).some((m) => !keep.has(m) && allowed(ix.node(m)!))).map((n) => n.id);
  return { nodes, edges, more };
}

/**
 * The graph with every member and relationship folded into its Type and
 * every part into its consumer, and parallel edges merged with a count:
 * the first view of a model too large to show whole.
 */
export function overview(graph: SemanticGraph): Subgraph & { readonly counts: Readonly<Record<string, number>> } {
  const ix = indexGraph(graph);
  const top = (id: string): string => {
    const n = ix.node(id)!;
    return (n.kind === "member" || n.kind === "relationship" || n.kind === "part") && n.parent ? top(n.parent) : id;
  };
  const folded = new Map<string, GraphEdge & { count: number }>();
  for (const e of graph.edges) {
    const from = top(e.from);
    const to = top(e.to);
    if (from === to) continue;
    const key = `${from}|${e.kind}|${to}`;
    const had = folded.get(key);
    if (had) had.count++;
    else folded.set(key, { from, to, kind: e.kind, basis: e.basis, count: 1 });
  }
  const nodes = graph.nodes.filter((n) => n.kind !== "member" && n.kind !== "relationship" && n.kind !== "part" && n.kind !== "marking");
  const shown = new Set(nodes.map((n) => n.id));
  const counts: Record<string, number> = {};
  for (const n of graph.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  const edges = [...folded.values()].filter((e) => shown.has(e.from) && shown.has(e.to));
  return { nodes, edges, more: nodes.filter((n) => ix.children(n.id).length > 0).map((n) => n.id), counts };
}

export const GRAPH_VIEWS = ["overview", "neighborhood", "dependents", "dependencies", "full"] as const;
export type GraphViewName = (typeof GRAPH_VIEWS)[number];

export interface GraphRequest {
  readonly view: GraphViewName;
  /** Required for every view but `overview` and `full`. */
  readonly node?: string;
  readonly depth?: number;
  readonly limit?: number;
}

/**
 * One view of a graph, as every host serves it: the graph's identity
 * (format, structure, digests) and the view's answer. Throws on a view it
 * does not know or a node the graph does not have.
 */
export function queryGraph(graph: SemanticGraph, req: GraphRequest): Record<string, unknown> {
  const meta = { format: graph.format, structure: graph.structure, modelDigest: graph.modelDigest, digest: graph.digest };
  switch (req.view) {
    case "full":
      return { ...meta, nodes: graph.nodes, edges: graph.edges };
    case "overview":
      return { ...meta, ...overview(graph) };
    case "neighborhood":
      return { ...meta, ...neighborhood(graph, req.node ?? "", { depth: req.depth ?? 1, limit: req.limit ?? 60 }) };
    case "dependents":
      return { ...meta, ...dependents(graph, req.node ?? "", req.depth === undefined ? {} : { depth: req.depth }) };
    case "dependencies":
      return { ...meta, ...dependencies(graph, req.node ?? "", req.depth === undefined ? {} : { depth: req.depth }) };
    default:
      throw new Error(`view is one of ${GRAPH_VIEWS.join(", ")}`);
  }
}
