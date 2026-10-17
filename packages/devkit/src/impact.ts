import { AuthorizationError, NotFoundError, type FindingOutcome, type Identity, type ModelDescription, type ModelInspection, type SemanticRuntime } from "@typesys/core";
import { diffModels, type ContractChange, type Impact, type VersionFinding } from "./diff.js";
import { dependents, governedGraph, indexGraph, isAcceptanceCheck, nodeId, semanticGraph, type GraphConsumer, type SemanticGraph } from "./graph.js";

export const BASELINE_FORMAT = "typesys.baseline/1";
export const IMPACT_FORMAT = "typesys.impact/1";

/** What recording a baseline asks of a runtime, each call decided for its caller. */
export type BaselineRuntime = Pick<SemanticRuntime, "describeModel" | "query" | "explain"> & Partial<Pick<SemanticRuntime, "canInspect" | "inspectModel">>;

/** One caller's read of one object, as the runtime decided it: outcomes only, never a value. */
export interface ProbeRecord {
  /** The caller's name in the baseline: `viewer`, or a subject id. */
  readonly as: string;
  readonly type: string;
  readonly id: string;
  /** The explanation's outcome for the whole read. */
  readonly outcome: string;
  /** Each value's outcome: `returned`, `withheld`, `no-value`... */
  readonly values: Readonly<Record<string, FindingOutcome>>;
}

/**
 * What a deployment's model is and decides now, kept to compare a change
 * against (ADR-0093): the description and, for an inspector, the
 * inspection, with how each caller's read of a few objects was decided.
 * It holds definitions and decisions, never data, so it can be committed
 * beside the code it describes.
 */
export interface Baseline {
  readonly format: typeof BASELINE_FORMAT;
  /** Who recorded it. */
  readonly by: string;
  readonly description: ModelDescription;
  /** Present when the recorder may inspect; without it, governance cannot be compared. */
  readonly inspection?: ModelInspection;
  readonly probes: readonly ProbeRecord[];
}

export interface BaselineOptions {
  /** The callers whose reads are recorded, by name. Each read is explained as that caller (ADR-0089). */
  readonly callers?: Readonly<Record<string, Identity>>;
  /** Only these Types. Default: every Type the recorder is told of. */
  readonly types?: readonly string[];
  /** Objects of each Type to probe. Default 1. */
  readonly probe?: number;
  /**
   * Objects probed beside those: the ones that matter to a consumer, such as
   * every object an application's acceptance checks name. The first object
   * of a Type is rarely the one a policy treats differently (an embargoed
   * notice, another carrier's freight).
   */
  readonly objects?: readonly { readonly type: string; readonly id: string }[];
  /**
   * Who explains each caller's read. `self` (the default): each caller
   * explains their own, for a host that holds the callers' identities, as a
   * CLI over an application's callers does. `recorder`: the recorder
   * explains it as each caller (`explain` with `as`), which the runtime
   * allows an inspector only, and audits as theirs: for a server whose
   * caller names other subjects.
   */
  readonly explainedBy?: "self" | "recorder";
}

/**
 * Records a baseline as `recorder` is told of the model. The objects probed
 * are the first the recorder may read of each Type, and each caller's read
 * of them is explained as that caller: what the caller's own read would
 * decide, with every value discarded.
 */
export async function recordBaseline(runtime: BaselineRuntime, recorder: Identity, opts: BaselineOptions = {}): Promise<Baseline> {
  const description = await runtime.describeModel(recorder);
  const inspection = runtime.canInspect && runtime.inspectModel && (await runtime.canInspect(recorder)) ? await runtime.inspectModel(recorder) : undefined;
  const wanted = opts.types ? new Set(opts.types) : undefined;
  const probes: ProbeRecord[] = [];
  for (const t of description.types) {
    if (wanted && !wanted.has(t.name)) continue;
    let ids: string[] = [];
    try {
      ids = (await runtime.query({ type: t.name, limit: opts.probe ?? 1 }, recorder)).items.map((o) => o.objectId);
    } catch {
      // Not readable by the recorder, or the source is down: nothing of it is probed, which the comparison says.
    }
    for (const o of opts.objects ?? []) if (o.type === t.name && !ids.includes(o.id)) ids.push(o.id);
    for (const id of ids)
      for (const [as, identity] of Object.entries(opts.callers ?? {})) {
        try {
          const e =
            opts.explainedBy === "recorder" && identity.subjectId !== recorder.subjectId
              ? await runtime.explain({ kind: "read", type: t.name, id }, recorder, { as: identity })
              : await runtime.explain({ kind: "read", type: t.name, id }, identity);
          probes.push({ as, type: t.name, id, outcome: e.outcome, values: Object.fromEntries(e.findings.flatMap((f) => (f.member ? [[f.member, f.outcome]] : []))) });
        } catch (err) {
          // Only a refusal is a decision; a failure decided nothing, and is compared as nothing (ADR-0093).
          probes.push({ as, type: t.name, id, outcome: err instanceof AuthorizationError ? "refused" : err instanceof NotFoundError ? "not-found" : "unavailable", values: {} });
        }
      }
  }
  return { format: BASELINE_FORMAT, by: recorder.subjectId, description, ...(inspection ? { inspection } : {}), probes };
}

/**
 * A baseline as one caller of a server may record it, the same for every
 * host (HTTP, MCP): their own reads, and, when the runtime lets them
 * inspect, the reads of every subject in the host's directory, each
 * explained by them as that subject (ADR-0089).
 */
export async function governedBaseline(
  runtime: BaselineRuntime & Pick<SemanticRuntime, "canInspect">,
  identity: Identity,
  subjects?: { list(): Promise<readonly { readonly subjectId: string }[]>; resolve(subjectId: string): Promise<Identity | undefined> }
): Promise<Baseline> {
  // The directory is asked only for an inspector, so no one else learns who is in it.
  const listed = subjects && (await runtime.canInspect(identity)) ? await subjects.list() : [];
  const others = (await Promise.all(listed.map((s) => subjects!.resolve(s.subjectId)))).filter((i): i is Identity => i !== undefined);
  const callers = Object.fromEntries([identity, ...others.filter((o) => o.subjectId !== identity.subjectId)].map((i) => [i.subjectId, i]));
  return recordBaseline(runtime, identity, { callers, explainedBy: "recorder" });
}

/**
 * Compares a baseline a caller of a server sent with the model as they
 * may learn it now, the same for every host (HTTP, MCP). The baseline is
 * the caller's to write, so unless they may inspect, what a change reaches
 * is found only in their own governed graph: a name they add to it is
 * compared, and echoed back, but never related to what uses it.
 */
export async function governedImpact(
  runtime: BaselineRuntime & Pick<SemanticRuntime, "canInspect" | "inspectModel" | "discovery">,
  identity: Identity,
  before: Baseline,
  consumers: readonly GraphConsumer[] = [],
  subjects?: Parameters<typeof governedBaseline>[2]
): Promise<ChangeImpact> {
  const now = await governedBaseline(runtime, identity, subjects);
  if (await runtime.canInspect(identity)) return analyzeChange(before, now, consumers);
  return analyzeChange(before, now, consumers, { graph: await governedGraph(runtime, identity, consumers) });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
const named = (v: unknown): v is Record<string, unknown> & { name: string } => isObject(v) && typeof v.name === "string";
const allOf = (v: unknown, ok: (x: unknown) => boolean): boolean => Array.isArray(v) && v.every(ok);
const marked = (v: Record<string, unknown>): boolean => isStrings(v.markings) && (v.withheldMarkings === undefined || typeof v.withheldMarkings === "number");

/** Whether `value` has the shape of a baseline, to the depth a comparison reads it: what a server checks before comparing one a caller sent. */
export function isBaseline(value: unknown): value is Baseline {
  if (!isObject(value) || value.format !== BASELINE_FORMAT || !isObject(value.description)) return false;
  const d = value.description;
  const describedType = (t: unknown) =>
    named(t) && isObject(t.properties) && isStrings(t.required) && allOf(t.computed, (c) => named(c) && isStrings(c.dependsOn)) && allOf(t.relationships, (r) => named(r) && typeof r.target === "string");
  if (!allOf(d.types, describedType) || !allOf(d.actions, (a) => named(a) && isStrings(a.applicableTypes))) return false;
  const probe = (p: unknown) => isObject(p) && typeof p.as === "string" && typeof p.type === "string" && typeof p.id === "string" && typeof p.outcome === "string" && isObject(p.values) && Object.values(p.values).every((o) => typeof o === "string");
  if (!allOf(value.probes, probe)) return false;
  if (value.inspection === undefined) return true;
  const i = value.inspection;
  if (!isObject(i) || typeof i.modelDigest !== "string") return false;
  const member = (m: unknown) => named(m) && marked(m) && (m.computed === undefined || (isObject(m.computed) && isStrings(m.computed.dependsOn) && isStrings(m.computed.releases)));
  const relationship = (r: unknown) => named(r) && marked(r) && isObject(r.source) && typeof r.source.dataSourceId === "string";
  const type = (t: unknown) => named(t) && marked(t) && typeof t.objectPolicy === "string" && allOf(t.members, member) && allOf(t.relationships, relationship);
  const action = (a: unknown) => named(a) && marked(a) && typeof a.policy === "string" && isObject(a.implementation) && allOf(a.preconditions, (p) => isObject(p) && typeof p.description === "string");
  return allOf(i.types, type) && allOf(i.actions, action) && allOf(i.policies, named) && allOf(i.sources, (x) => isObject(x) && typeof x.id === "string");
}

/** `narrows`: fewer callers may read or invoke it. `widens`: more may. `changes`: neither plainly. */
export type GovernanceEffect = "narrows" | "widens" | "changes";

/**
 * One change and what it reaches (ADR-0093). `predicted` changes are found
 * by comparing the definitions; `observed` ones by deciding the same reads
 * against both and comparing the decisions.
 */
export interface ImpactItem {
  readonly kind: "contract" | "governance" | "observed";
  readonly basis: "predicted" | "observed";
  /** `Type`, `Type.value`, `Action`, `Action.input.name`, `policy:name`. */
  readonly subject: string;
  readonly change: string;
  /** For a contract change (ADR-0056). */
  readonly impact?: Impact;
  /** For a governance or observed change. */
  readonly effect?: GovernanceEffect;
  /** For an observed change: whose read changed, and on which object. */
  readonly as?: string;
  readonly object?: string;
  /** The graph node the subject is, when the graph has it. */
  readonly node?: string;
  readonly reaches: Reaches;
}

export interface Reaches {
  /** Workflows and applications that depend on the subject. */
  readonly consumers: readonly string[];
  /** Their parts that depend on it. */
  readonly parts: readonly string[];
  /** The acceptance checks among them: run these. */
  readonly checks: readonly string[];
  /** Parts whose uses are not declared, so they may depend on it and not be listed. */
  readonly opaque: readonly string[];
}

export interface ChangeImpact {
  readonly format: typeof IMPACT_FORMAT;
  readonly before: string;
  readonly after: string;
  /** The worst contract impact, or `risky` for any governance or observed change. */
  readonly verdict: Impact;
  /** Observed changes that let a caller read what they could not: the ones to review first. */
  readonly exposures: readonly ImpactItem[];
  readonly items: readonly ImpactItem[];
  /** Every check any change reaches. */
  readonly checks: readonly string[];
  readonly underVersioned: readonly VersionFinding[];
  /** `compared` when both baselines carry an inspection. */
  readonly governance: "compared" | "unavailable";
  /** `compared` when both record the same callers' reads; `unavailable` when neither records any. */
  readonly observed: "compared" | "unavailable";
  readonly caveat: string;
}

export const IMPACT_CAVEAT =
  "Predicted changes come from the definitions and the consumers given; a part that declares nothing may depend on more. Observed changes are the runtime's decisions on the objects probed, so another object can be decided differently.";

export interface AnalyzeOptions {
  /**
   * The only graph a change's reach is found in. A server passes the
   * caller's own governed graph (`governedGraph`) when they may not
   * inspect: a baseline they send is theirs to write, so a graph built
   * from it, or from consumers' uses of names it adds, would tell them
   * what uses a value they are not told of. Default: graphs of both
   * baselines, keeping uses of names neither declares, for a host that
   * trusts both, as the CLI over an application's own files does.
   */
  readonly graph?: SemanticGraph;
}

/** What changed between two baselines, and what each change reaches among `consumers` (`workflowUses`, `appUses`). */
export function analyzeChange(before: Baseline, after: Baseline, consumers: readonly GraphConsumer[] = [], opts: AnalyzeOptions = {}): ChangeImpact {
  const graphs = opts.graph ? [opts.graph] : [after, before].map((b) => semanticGraph(b.inspection ?? b.description, consumers, { unresolved: "keep" }));
  const models = opts.graph ? [after.description] : [after.description, before.description];
  const items: ImpactItem[] = [];
  const contract = diffModels(before.description, after.description);
  for (const c of contract.changes) items.push(item(graphs, models, { kind: "contract", basis: "predicted", subject: c.subject, change: c.change, impact: c.impact }));
  const governance = before.inspection && after.inspection ? "compared" : "unavailable";
  if (before.inspection && after.inspection) for (const g of diffGovernance(before.inspection, after.inspection)) items.push(item(graphs, models, { kind: "governance", basis: "predicted", ...g }));
  const observed = before.probes.length + after.probes.length > 0 ? "compared" : "unavailable";
  for (const o of diffProbes(before.probes, after.probes)) items.push(item(graphs, models, { kind: "observed", basis: "observed", ...o }));
  const rank: Record<Impact, number> = { compatible: 0, risky: 1, breaking: 2 };
  const verdict = items.reduce<Impact>((worst, i) => {
    const level: Impact = i.impact ?? "risky";
    return rank[level] > rank[worst] ? level : worst;
  }, contract.underVersioned.length ? "risky" : "compatible");
  return {
    format: IMPACT_FORMAT,
    before: before.inspection?.modelDigest ?? (graphs[1] ?? semanticGraph(before.description)).modelDigest,
    after: after.inspection?.modelDigest ?? (opts.graph ? semanticGraph(after.description) : graphs[0]!).modelDigest,
    verdict,
    exposures: items.filter((i) => i.kind === "observed" && i.effect === "widens"),
    items,
    checks: [...new Set(items.flatMap((i) => i.reaches.checks))].sort(),
    underVersioned: contract.underVersioned,
    governance,
    observed,
    caveat: IMPACT_CAVEAT
  };
}

type Draft = Omit<ImpactItem, "node" | "reaches">;

/** The graph node a subject names: a Type, a value or relationship of one, an Action, or a policy. */
export function subjectNode(subject: string, model: ModelDescription): string | undefined {
  if (subject.startsWith("policy:")) return nodeId.policy(subject.slice("policy:".length));
  if (subject.startsWith("source:")) return nodeId.source(subject.slice("source:".length));
  const action = model.actions.find((a) => subject === a.name || subject.startsWith(`${a.name}.`));
  if (action) return nodeId.action(action.name);
  const type = [...model.types].sort((a, b) => b.name.length - a.name.length).find((t) => subject === t.name || subject.startsWith(`${t.name}.`));
  if (!type) return undefined;
  if (subject === type.name) return nodeId.type(type.name);
  const member = subject.slice(type.name.length + 1).split(".")[0]!;
  return type.relationships.some((r) => r.name === member) ? nodeId.relationship(type.name, member) : nodeId.member(type.name, member);
}

function item(graphs: readonly SemanticGraph[], models: readonly ModelDescription[], draft: Draft): ImpactItem {
  for (const [i, graph] of graphs.entries()) {
    const id = subjectNode(draft.subject, models[i]!);
    if (id && indexGraph(graph).node(id)) return { ...draft, node: id, reaches: reachesOf(graph, id) };
  }
  return { ...draft, reaches: { consumers: [], parts: [], checks: [], opaque: [] } };
}

function reachesOf(graph: SemanticGraph, id: string): Reaches {
  const r = dependents(graph, id);
  const parts = r.reached.filter((x) => x.kind === "part").map((x) => x.id);
  return {
    consumers: r.consumers,
    parts,
    checks: parts.filter((p) => isAcceptanceCheck(graph, p)),
    // Every part that declares nothing may read the subject, reached or not.
    opaque: graph.nodes.filter((n) => n.kind === "part" && n.detail?.opaque !== undefined).map((n) => n.id)
  };
}

const sameList = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((x) => b.includes(x));

interface Marked {
  readonly markings: readonly string[];
  readonly withheldMarkings?: number;
}

function marks(subject: string, before: Marked, after: Marked, out: Omit<Draft, "kind" | "basis">[]): void {
  const added = after.markings.filter((m) => !before.markings.includes(m));
  const removed = before.markings.filter((m) => !after.markings.includes(m));
  if (added.length) out.push({ subject, change: `now marked ${added.join(", ")}`, effect: "narrows" });
  if (removed.length) out.push({ subject, change: `no longer marked ${removed.join(", ")}`, effect: "widens" });
  // Markings the recorder may not learn of are counted, not named (ADR-0088): a change in the count is still a change.
  const [was, now] = [before.withheldMarkings ?? 0, after.withheldMarkings ?? 0];
  if (was !== now) out.push({ subject, change: `${now} marking${now === 1 ? "" : "s"} you may not learn of, was ${was}`, effect: now > was ? "narrows" : "widens" });
}

function policy(subject: string, what: string, before: string | undefined, after: string | undefined, out: Omit<Draft, "kind" | "basis">[]): void {
  if (before === after) return;
  if (!before) out.push({ subject, change: `${what} now guarded by ${after}`, effect: "narrows" });
  else if (!after) out.push({ subject, change: `${what} no longer guarded by ${before}`, effect: "widens" });
  else out.push({ subject, change: `${what} guarded by ${after}, was ${before}`, effect: "changes" });
}

/** The enforcement structure's changes (ADR-0088): policies, markings, releases, sources and audit, between two inspections. */
export function diffGovernance(before: ModelInspection, after: ModelInspection): Omit<Draft, "kind" | "basis">[] {
  const out: Omit<Draft, "kind" | "basis">[] = [];
  const beforeTypes = new Map(before.types.map((t) => [t.name, t]));
  for (const a of after.types) {
    const b = beforeTypes.get(a.name);
    if (!b) continue;
    policy(a.name, "every read", b.objectPolicy, a.objectPolicy, out);
    marks(a.name, b, a, out);
    if (b.source?.dataSourceId !== a.source?.dataSourceId) out.push({ subject: a.name, change: `read from ${a.source?.dataSourceId ?? "no source"}, was ${b.source?.dataSourceId ?? "no source"}`, effect: "changes" });
    const members = new Map(b.members.map((m) => [m.name, m]));
    for (const am of a.members) {
      const bm = members.get(am.name);
      if (!bm) continue;
      const subject = `${a.name}.${am.name}`;
      policy(subject, "its read", bm.policy, am.policy, out);
      marks(subject, bm, am, out);
      if (bm.source?.dataSourceId !== am.source?.dataSourceId) out.push({ subject, change: `read from ${am.source?.dataSourceId ?? "no source"}, was ${bm.source?.dataSourceId ?? "no source"}`, effect: "changes" });
      const [br, ar] = [bm.computed?.releases ?? [], am.computed?.releases ?? []];
      const released = ar.filter((x) => !br.includes(x));
      const unreleased = br.filter((x) => !ar.includes(x));
      if (released.length) out.push({ subject, change: `now released from ${released.join(", ")}: readers who may not read ${released.length === 1 ? "it" : "them"} are returned this value`, effect: "widens" });
      if (unreleased.length) out.push({ subject, change: `no longer released from ${unreleased.join(", ")}`, effect: "narrows" });
      const [bDeps, aDeps] = [bm.computed?.dependsOn ?? [], am.computed?.dependsOn ?? []];
      const dependsNow = aDeps.filter((x) => !bDeps.includes(x));
      const dependsNoLonger = bDeps.filter((x) => !aDeps.includes(x));
      // A computed value is withheld from a reader withheld one of its inputs (ADR-0052), so an input added narrows and one removed widens.
      if (bm.computed && am.computed && dependsNow.length) out.push({ subject, change: `now computed from ${dependsNow.join(", ")} too: readers withheld ${dependsNow.length === 1 ? "it" : "any of them"} are withheld this value`, effect: "narrows" });
      if (bm.computed && am.computed && dependsNoLonger.length) out.push({ subject, change: `no longer computed from ${dependsNoLonger.join(", ")}: readers withheld only ${dependsNoLonger.length === 1 ? "it" : "them"} are now returned this value`, effect: "widens" });
      const [bReads, aReads] = [bm.computed?.reads, am.computed?.reads];
      if (bm.computed && am.computed && JSON.stringify(bReads) !== JSON.stringify(aReads)) out.push({ subject, change: `reads ${aReads === "undeclared" ? "any source (undeclared)" : (aReads ?? []).join(", ") || "no source"}, was ${bReads === "undeclared" ? "any source (undeclared)" : (bReads ?? []).join(", ") || "no source"}`, effect: aReads === "undeclared" ? "widens" : "changes" });
    }
    const rels = new Map(b.relationships.map((r) => [r.name, r]));
    for (const ar of a.relationships) {
      const br = rels.get(ar.name);
      if (!br) continue;
      policy(`${a.name}.${ar.name}`, "traversing it", br.policy, ar.policy, out);
      marks(`${a.name}.${ar.name}`, br, ar, out);
      if (br.source.dataSourceId !== ar.source.dataSourceId) out.push({ subject: `${a.name}.${ar.name}`, change: `resolved through ${ar.source.dataSourceId}, was ${br.source.dataSourceId}`, effect: "changes" });
    }
  }
  const beforeActions = new Map(before.actions.map((x) => [x.name, x]));
  for (const a of after.actions) {
    const b = beforeActions.get(a.name);
    if (!b) continue;
    policy(a.name, "invoking it", b.policy, a.policy, out);
    marks(a.name, b, a, out);
    if (b.implementation.dataSourceId !== a.implementation.dataSourceId) out.push({ subject: a.name, change: `writes to ${a.implementation.dataSourceId}, was ${b.implementation.dataSourceId}`, effect: "changes" });
    if (b.auditRequired !== a.auditRequired) out.push({ subject: a.name, change: a.auditRequired ? "now audited" : "no longer audited", effect: "changes" });
    if (!sameList(b.preconditions.map((p) => p.description), a.preconditions.map((p) => p.description))) out.push({ subject: a.name, change: "its preconditions changed", effect: "changes" });
  }
  const beforePolicies = new Map(before.policies.map((p) => [p.name, p]));
  for (const p of after.policies) {
    const b = beforePolicies.get(p.name);
    if (b && b.rule !== p.rule) out.push({ subject: `policy:${p.name}`, change: `rule is ${p.rule ?? "not described"}, was ${b.rule ?? "not described"}`, effect: "changes" });
  }
  const beforeSources = new Map(before.sources.map((s) => [s.id, s]));
  for (const s of after.sources) {
    const b = beforeSources.get(s.id);
    if (b && b.connected !== s.connected) out.push({ subject: `source:${s.id}`, change: s.connected ? "now connected" : "no longer connected", effect: "changes" });
  }
  return out;
}

const readable = (o: string | undefined) => o === "returned" || o === "no-value";

/** The reads whose decisions changed: a caller now returned a value they were not, or the reverse. */
function diffProbes(before: readonly ProbeRecord[], after: readonly ProbeRecord[]): Omit<Draft, "kind" | "basis">[] {
  const out: Omit<Draft, "kind" | "basis">[] = [];
  const key = (p: ProbeRecord) => `${p.as}|${p.type}|${p.id}`;
  const afterByKey = new Map(after.map((p) => [key(p), p]));
  for (const b of before) {
    const a = afterByKey.get(key(b));
    const object = `${b.type}/${b.id}`;
    if (!a) {
      out.push({ subject: b.type, as: b.as, object, change: "not probed after the change: the object or the Type is no longer read", effect: "changes" });
      continue;
    }
    // A read a source could not answer decided nothing about who sees what, so it is not compared, and says so.
    const unavailable = [b, a].filter((p) => p.outcome === "unavailable" || Object.values(p.values).includes("unavailable"));
    if (unavailable.length) {
      out.push({ subject: b.type, as: b.as, object, change: `not compared: a source was unavailable ${unavailable.length === 2 ? "both times" : unavailable[0] === b ? "when the baseline was recorded" : "now"}`, effect: "changes" });
      continue;
    }
    if (b.outcome !== a.outcome && (b.outcome === "refused" || a.outcome === "refused" || b.outcome === "not-found" || a.outcome === "not-found"))
      out.push({ subject: b.type, as: b.as, object, change: `the read is ${a.outcome}, was ${b.outcome}`, effect: readable(a.outcome === "partial" ? "returned" : a.outcome === "allowed" ? "returned" : a.outcome) ? "widens" : "narrows" });
    for (const member of [...new Set([...Object.keys(b.values), ...Object.keys(a.values)])].sort()) {
      // Own keys only: a member named like `constructor` is not found on the prototype.
      const [was, now] = [Object.hasOwn(b.values, member) ? b.values[member] : undefined, Object.hasOwn(a.values, member) ? a.values[member] : undefined];
      if (readable(was) === readable(now)) continue;
      out.push({ subject: `${b.type}.${member}`, as: b.as, object, change: readable(now) ? `now returned to ${b.as}, was ${was ?? "not described"}` : `now ${now ?? "not described"} for ${b.as}, was returned`, effect: readable(now) ? "widens" : "narrows" });
    }
  }
  return out;
}

/** The analysis as lines for a terminal, most consequential first. */
export function renderImpact(impact: ChangeImpact): string[] {
  const order = (i: ImpactItem) => (i.kind === "observed" && i.effect === "widens" ? 0 : i.impact === "breaking" ? 1 : i.kind === "governance" ? 2 : 3);
  const lines = [`Change ${impact.before.replace(/^sha256:/, "").slice(0, 12)} → ${impact.after.replace(/^sha256:/, "").slice(0, 12)}: ${impact.verdict}${impact.exposures.length ? `, ${impact.exposures.length} new exposure${impact.exposures.length === 1 ? "" : "s"}` : ""}`];
  for (const i of [...impact.items].sort((a, b) => order(a) - order(b))) {
    const tag = i.kind === "contract" ? i.impact! : `${i.kind} ${i.effect}`;
    lines.push(`  ${tag.padEnd(20)} ${i.subject}${i.object && i.subject !== i.object.split("/")[0] ? ` on ${i.object}` : ""}: ${i.change}`);
    if (i.reaches.consumers.length) lines.push(`  ${"".padEnd(20)} reaches ${i.reaches.consumers.join(", ")}`);
  }
  if (impact.items.length === 0) lines.push("  No change.");
  for (const v of impact.underVersioned) lines.push(`  ${"version".padEnd(20)} ${v.subject}: ${v.from} → ${v.to}, but its changes need a ${v.needs} bump`);
  if (impact.checks.length) lines.push(`Checks to run: ${impact.checks.join(", ")}`);
  if (impact.governance === "unavailable") lines.push("Governance not compared: a baseline was recorded by someone who may not inspect.");
  if (impact.observed === "unavailable") lines.push("Nothing observed: neither baseline probed a caller's reads.");
  return lines;
}

export type { ContractChange };
