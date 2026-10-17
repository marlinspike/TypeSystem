import { createHash } from "node:crypto";
import { canonical, type ActionDescription, type Explanation, type Identity, type ModelDescription, type SemanticRuntime, type TypeDescription, type TypeInspection } from "@typesys/core";
import { compactType } from "./catalog.js";
import { discover } from "./discover.js";
import { dependents, indexGraph, nodeId, semanticGraph, type GraphConsumer, type SemanticGraph } from "./graph.js";

export const CONTEXT_FORMAT = "typesys.context/1";

/**
 * What compiling a context needs of a runtime: the calls a caller's own
 * client would make. The rest is optional (ADR-0092): with `explain` each
 * value's outcome is verified rather than inferred from a sample, with
 * `canInspect` and `inspectModel` an inspector is shown what guards each
 * value, and `queryLimits` and `discovery` say how to query and what a
 * consumer may name.
 */
export type ContextRuntime = Pick<SemanticRuntime, "describeModel" | "query" | "listActions"> &
  Partial<Pick<SemanticRuntime, "explain" | "canInspect" | "inspectModel">> & {
    readonly discovery?: SemanticRuntime["discovery"];
    readonly queryLimits?: { readonly maxLimit: number };
  };

export interface ContextOptions {
  /** The coding task in words: what the context is for. */
  readonly task: string;
  /** Types or Actions to include whatever the task says. */
  readonly focus?: readonly string[];
  /** Upper bound on the rendered context, in estimated tokens (four characters each). Default 4,000. */
  readonly maxTokens?: number;
  /**
   * Objects of each Type to read as the caller, to learn which values they
   * are returned. Default 3; 0 reads nothing and says nothing about
   * visibility.
   */
  readonly probe?: number;
  /** Include up to this many of the probed objects' values as examples, as the caller was returned them. Default 0. */
  readonly examples?: number;
  /** What is built on the model (`workflowUses`, `appUses`): each part that uses a selected Type is listed with it (ADR-0092). */
  readonly consumers?: readonly GraphConsumer[];
}

/**
 * How a statement in a context is known (ADR-0092). `verified`: the
 * runtime decided it for this caller. `inferred`: concluded from a sample.
 * `withheld`: the runtime decided this caller may not have it.
 * `unavailable`: the context could not say.
 */
export type ContextStatus = "verified" | "inferred" | "withheld" | "unavailable";

/** Whether this caller is returned one value, and how that is known. */
export interface ValueAccess {
  readonly member: string;
  readonly status: ContextStatus;
  /** What was found: `returned`, `no value on the probed object`, the control that withheld it, why it is unknown. */
  readonly note: string;
}

/** A workflow or application part that uses a selected Type (ADR-0090). */
export interface ContextUse {
  /** `workflow airforce.GroundForRepair`, `app squadron`. */
  readonly consumer: string;
  /** The part's label, absent for a use by the consumer as a whole. */
  readonly part?: string;
  /** `read`, `page`, `check`... */
  readonly partKind?: string;
  /** The member it uses, absent for the whole Type. */
  readonly member?: string;
  readonly how?: string;
}

/** What guards a Type's values, shown to an inspector only (ADR-0088). */
export interface ContextGuards {
  readonly objectPolicy: string;
  readonly source?: string;
  readonly markings: readonly string[];
  readonly members: readonly { readonly name: string; readonly source?: string; readonly policy?: string; readonly markings: readonly string[]; readonly releases?: readonly string[] }[];
}

export interface ContextType {
  readonly name: string;
  readonly description?: string;
  /** Why it is in the context: the task names it, it was asked for, or a selected Type relates to it. */
  readonly reason: "task" | "focus" | "related" | "action";
  readonly values: readonly { readonly name: string; readonly type: string; readonly required: boolean; readonly description?: string; readonly values?: readonly unknown[] }[];
  readonly computed: readonly { readonly name: string; readonly type: string; readonly dependsOn: readonly string[] }[];
  readonly relationships: readonly { readonly name: string; readonly target: string; readonly many: boolean }[];
  /**
   * What reading as this caller returned, on the objects probed: values
   * returned on at least one, and values returned on none. Absent when
   * nothing was probed or nothing could be read.
   */
  readonly visibility?: { readonly probed: number; readonly returned: readonly string[]; readonly neverReturned: readonly string[] };
  /** Each value's outcome for this caller and how it is known. Absent when nothing was probed. */
  readonly access?: readonly ValueAccess[];
  /** How a query of it may be written: a top-level sort and a search name stored values only; a filter may name any. */
  readonly query: { readonly sortable: readonly string[]; readonly searchable: readonly string[]; readonly filterable: "any"; readonly maxLimit?: number };
  /** Lines of the typed SDK for reading it, naming only what exists. */
  readonly sdk: readonly string[];
  /** The consumers' parts that use it directly. */
  readonly usedBy: readonly ContextUse[];
  /** Inspectors only. */
  readonly guards?: ContextGuards;
  readonly examples?: readonly { readonly objectId: string; readonly values: Readonly<Record<string, unknown>> }[];
}

export interface ContextAction {
  readonly name: string;
  readonly description: string;
  readonly reason: ContextType["reason"];
  readonly on: string;
  /** Whether this caller may invoke it, decided per Type; an instance-scoped Action may still be refused on one object. */
  readonly invocable: boolean;
  readonly instanceScoped: boolean;
  readonly input: string;
  readonly effect: string;
  /** The Types it acts on, applies to and returns: it is in a context only with each of them. */
  readonly needs: readonly string[];
  /** Lines of the typed SDK to preview and invoke it. */
  readonly sdk: readonly string[];
}

export interface LeftOut {
  readonly name: string;
  /** `budget`, or `needs <Type>`: an Action left out because a Type it needs was. */
  readonly reason: string;
}

/** An acceptance check that uses a selected Type: a change must keep it passing. */
export interface ContextCheck {
  readonly consumer: string;
  readonly check: string;
}

/**
 * A model context compiled for one coding task and one caller (ADR-0078,
 * ADR-0092): the part of the governed model the task needs, as that caller
 * is told of it and returned it, small enough to put in a prompt, with each
 * statement marked with how it is known. It is decided by the runtime, so a
 * coding agent is never told of a Type its caller may not learn of, nor
 * shown a value its caller may not read.
 */
export interface CompiledContext {
  readonly format: typeof CONTEXT_FORMAT;
  readonly task: string;
  readonly as: string;
  readonly audience?: string;
  readonly types: readonly ContextType[];
  readonly actions: readonly ContextAction[];
  /** Selected but left out to stay within `maxTokens`, most relevant first. */
  readonly omitted: readonly string[];
  /** The same, each with why. */
  readonly leftOut: readonly LeftOut[];
  /** The checks among the consumers' parts that use a selected Type. */
  readonly checks: readonly ContextCheck[];
  /** Consumer parts whose uses may be incomplete: whether they use a selected Type is unavailable. */
  readonly opaque: readonly string[];
  /** The inspection's digest for an inspector, else the description's: which model the context describes. */
  readonly modelDigest: string;
  /** `shown`: the caller may inspect, so sources, policies and markings are in the context. `withheld`: they are not. */
  readonly governance: "shown" | "withheld";
  readonly caveat: string;
  /** The context as text for a prompt. */
  readonly text: string;
  readonly tokens: number;
  /** sha256 of the rendered text: the same model, caller and task compile to the same context. */
  readonly digest: string;
}

export const CONTEXT_CAVEAT = "This context is a prediction made now, for this caller. The runtime decides every call your code makes, and can decide a later one differently.";

const estimate = (text: string) => Math.ceil(text.length / 4);

const GUIDANCE = [
  "Read and change data only through TypeSystem: the runtime's API, the typed SDK, or MCP. Never query a source system directly; its rows are not governed.",
  "Values a caller may not read are left out of what they are returned, not set to null. Write code that treats any value as possibly absent.",
  "Changes happen only through Actions. An Action can be refused for one object while allowed on others; check the result.",
  "A refusal is a decision, not an error to retry or work around.",
  "Marks: a value with no mark was returned to this caller (verified). [withheld] the runtime decided this caller may not read it. [inferred] concluded from the objects probed. [unavailable] could not be determined."
];

/** Compiles the context `options.task` needs, as `identity` is told of the model and returned its objects. */
export async function compileContext(runtime: ContextRuntime, identity: Identity, options: ContextOptions): Promise<CompiledContext> {
  const model: ModelDescription = await runtime.describeModel(identity);
  const inspector = runtime.canInspect && runtime.inspectModel ? await runtime.canInspect(identity) : false;
  const inspection = inspector ? await runtime.inspectModel!(identity) : undefined;
  const graph = semanticGraph(inspection ?? model, options.consumers ?? [], { unresolved: runtime.discovery === "open" ? "keep" : "drop" });
  const typeByName = new Map(model.types.map((t) => [t.name, t]));
  const actionByName = new Map(model.actions.map((a) => [a.name, a]));
  const inspected = new Map((inspection?.types ?? []).map((t) => [t.name, t]));
  const outputOf = new Map((inspection?.actions ?? []).flatMap((a) => (a.outputType ? [[a.name, a.outputType] as const] : [])));
  const needsOf = (a: ActionDescription) => [...new Set([...(a.target ? [a.target.type] : []), ...a.applicableTypes, ...(outputOf.has(a.name) ? [outputOf.get(a.name)!] : [])])].filter((t) => typeByName.has(t));

  // Most relevant first: what the caller asked for, then what the task's words find, then what those relate to.
  const found: { name: string; kind: "type" | "action"; reason: ContextType["reason"] }[] = [];
  const seen = new Set<string>();
  const add = (name: string, reason: ContextType["reason"]) => {
    if (seen.has(name)) return;
    const kind = typeByName.has(name) ? "type" : actionByName.has(name) ? "action" : undefined;
    if (!kind) return;
    seen.add(name);
    found.push({ name, kind, reason });
  };
  for (const f of options.focus ?? []) add(f, "focus");
  const matches = discover(model, options.task, { limit: model.types.length + model.actions.length });
  for (const m of matches) add(m.name, "task");
  if (matches.length === 0 && (options.focus ?? []).length === 0) for (const t of model.types) add(t.name, "task");
  for (const o of [...found]) {
    if (o.kind === "type") {
      for (const r of typeByName.get(o.name)!.relationships) add(r.target, "related");
      for (const a of typeByName.get(o.name)!.actions) add(a, "action");
    } else for (const t of needsOf(actionByName.get(o.name)!)) add(t, "related");
  }
  // Dependency-complete (ADR-0092): every Type an Action needs comes before it, so the budget meets the Type first.
  const order: typeof found = [];
  const placed = new Set<string>();
  for (const o of found) {
    if (placed.has(o.name)) continue;
    if (o.kind === "action") for (const t of needsOf(actionByName.get(o.name)!)) if (!placed.has(t)) {
      placed.add(t);
      order.push(found.find((f) => f.name === t)!);
    }
    placed.add(o.name);
    order.push(o);
  }

  const probe = options.probe ?? 3;
  const types: ContextType[] = [];
  const actions: ContextAction[] = [];
  const leftOut: LeftOut[] = [];
  const budget = options.maxTokens ?? 4_000;
  const governance = inspector ? "shown" : "withheld";
  let used = estimate(header(options.task, identity, graph.modelDigest, governance)) + estimate(GUIDANCE.join("\n")) + estimate(CONTEXT_CAVEAT);
  for (const o of order) {
    if (o.kind === "action") {
      const missing = needsOf(actionByName.get(o.name)!).filter((t) => !types.some((x) => x.name === t));
      if (missing.length > 0) {
        leftOut.push({ name: o.name, reason: `needs ${missing.join(", ")}` });
        continue;
      }
    }
    const entry =
      o.kind === "type"
        ? await typeEntry(runtime, identity, typeByName.get(o.name)!, o.reason, { probe, examples: options.examples ?? 0, graph, guards: inspected.get(o.name) })
        : await actionEntries(runtime, identity, actionByName.get(o.name)!, o.reason, needsOf(actionByName.get(o.name)!));
    const text = o.kind === "type" ? renderType(entry as ContextType) : (entry as ContextAction[]).map(renderAction).join("\n");
    if (used + estimate(text) > budget) {
      leftOut.push({ name: o.name, reason: "budget" });
      continue;
    }
    used += estimate(text);
    if (o.kind === "type") types.push(entry as ContextType);
    else actions.push(...(entry as ContextAction[]));
  }

  const rank = new Map(order.map((o, i) => [o.name, i]));
  const sortLeftOut = () => leftOut.sort((a, b) => rank.get(a.name)! - rank.get(b.name)!);
  sortLeftOut();
  const checksOf = () => uniqueChecks(types);
  const opaque = graph.nodes.filter((n) => n.kind === "part" && n.detail?.opaque !== undefined).map((n) => n.id);
  let task = options.task;
  const render = () => {
    const checks = checksOf();
    return [
      header(task, identity, graph.modelDigest, governance),
      "",
      "TYPES",
      ...types.map(renderType),
      "",
      "ACTIONS",
      ...(actions.length ? actions.map(renderAction) : ["  (none)"]),
      ...(checks.length ? ["", "CHECKS a change must keep passing", ...checks.map((c) => `  ${c.consumer}: ${c.check}`)] : []),
      ...(opaque.length ? ["", `[unavailable] whether these parts use the Types above: ${opaque.map((o) => o.replace(/^part:/, "")).join(", ")} (they read through code that declares nothing)`] : []),
      "",
      "RULES",
      ...usage(types, actions),
      ...GUIDANCE.map((g) => `- ${g}`),
      `- ${CONTEXT_CAVEAT}`,
      ...(leftOut.length ? ["", `LEFT OUT to stay within ${budget} tokens: ${leftOut.map((l) => (l.reason === "budget" ? l.name : `${l.name} (${l.reason})`)).join(", ")}`] : [])
    ].join("\n");
  };
  // The headings and the list of what was left out count too: drop the least relevant until the whole fits.
  let text = render();
  while (estimate(text) > budget && types.length + actions.length > 0) {
    const last = order.filter((o) => types.some((t) => t.name === o.name) || actions.some((a) => a.name === o.name)).at(-1)!;
    if (last.kind === "type") {
      types.splice(types.findIndex((t) => t.name === last.name), 1);
      // An Action never stays without a Type it needs.
      for (let i = actions.length - 1; i >= 0; i--) if (actions[i]!.needs.includes(last.name)) leftOut.push({ name: actions.splice(i, 1)[0]!.name, reason: `needs ${last.name}` });
    } else actions.splice(actions.findIndex((a) => a.name === last.name), 1);
    leftOut.push({ name: last.name, reason: "budget" });
    sortLeftOut();
    text = render();
  }
  // A task longer than the budget allows is shortened in the header (M3 review L4); the rules are never dropped.
  if (estimate(text) > budget) {
    const room = budget * 4 - (text.length - task.length) - 1;
    if (room < 20) throw new RangeError(`maxTokens ${budget} is less than the context's rules and header need (${estimate(text) - estimate(task)} tokens)`);
    task = `${options.task.slice(0, room)}…`;
    text = render();
  }
  return {
    format: CONTEXT_FORMAT,
    task: options.task,
    as: identity.subjectId,
    ...(identity.audience ? { audience: identity.audience.id } : {}),
    types,
    actions,
    omitted: leftOut.map((l) => l.name),
    leftOut,
    checks: checksOf(),
    opaque,
    modelDigest: graph.modelDigest,
    governance,
    caveat: CONTEXT_CAVEAT,
    text,
    tokens: estimate(text),
    digest: `sha256:${createHash("sha256").update(canonical({ text })).digest("hex")}`
  };
}

function header(task: string, identity: Identity, modelDigest: string, governance: CompiledContext["governance"]): string {
  return [
    `TypeSystem model context for: ${task}`,
    `As ${identity.subjectId}${identity.audience ? `, reading for ${identity.audience.id}` : ""}. Only what this caller is told of and returned is shown.`,
    `Model ${modelDigest.replace(/^sha256:/, "").slice(0, 16)}. ${governance === "shown" ? "Sources, policies and markings are shown: this caller may inspect." : "Sources, policies and markings are withheld from this caller."}`
  ].join("\n");
}

/** How to query and call, once for the whole context: the same for every Type, so it is not repeated per Type. Each Type's and Action's own lines are in `sdk`. */
function usage(types: readonly ContextType[], actions: readonly ContextAction[]): string[] {
  const t = types[0];
  const a = actions[0];
  if (!t) return [];
  return [
    `- Query: a filter may name any value; a top-level sort and a search name stored values only, never a computed one${t.query.maxLimit ? `; at most ${t.query.maxLimit} objects a page` : ""}.`,
    `- With the typed SDK: ${t.sdk.join("; ")}${a ? `; ${a.sdk.join(" or ")}` : ""}.`
  ];
}

function uniqueChecks(types: readonly ContextType[]): ContextCheck[] {
  const out = new Map<string, ContextCheck>();
  for (const t of types) for (const u of t.usedBy) if (u.partKind === "check" && u.part) out.set(`${u.consumer}|${u.part}`, { consumer: u.consumer, check: u.part });
  return [...out.values()].sort((a, b) => `${a.consumer}|${a.check}`.localeCompare(`${b.consumer}|${b.check}`));
}

interface TypeEntryOptions {
  readonly probe: number;
  readonly examples: number;
  readonly graph: SemanticGraph;
  readonly guards: TypeInspection | undefined;
}

async function typeEntry(runtime: ContextRuntime, identity: Identity, t: TypeDescription, reason: ContextType["reason"], opts: TypeEntryOptions): Promise<ContextType> {
  const required = new Set(t.required);
  const values = Object.entries(t.properties).map(([name, s]) => ({
    name,
    type: compactType(s),
    required: required.has(name),
    ...(s.description ? { description: s.description } : {}),
    ...(Array.isArray(s.enum) ? { values: s.enum } : {})
  }));
  // Computed values are observed like any other (ADR-0078): one can be withheld while what it depends on is not, and the reverse.
  const names = [...values.map((v) => v.name), ...t.computed.map((c) => c.name)];
  let visibility: ContextType["visibility"];
  let access: ValueAccess[] | undefined;
  let sample: ContextType["examples"];
  if (opts.probe > 0) {
    try {
      const items = (await runtime.query({ type: t.name, limit: opts.probe }, identity)).items;
      if (items.length > 0) {
        const returned = new Set(items.flatMap((o) => Object.keys(o.values)));
        visibility = { probed: items.length, returned: names.filter((n) => returned.has(n)), neverReturned: names.filter((n) => !returned.has(n)) };
        if (opts.examples > 0) sample = items.slice(0, opts.examples).map((o) => ({ objectId: o.objectId, values: o.values }));
        const explained = await explainOne(runtime, identity, t.name, items[0]!.objectId);
        access = names.map((n) => valueAccess(n, returned.has(n), items.length, explained));
      } else access = names.map((member) => ({ member, status: "unavailable", note: "no object to probe" }));
    } catch (e) {
      // Refused, or the source did not answer: what the caller would learn, and nothing more.
      const refused = e instanceof Error && e.name === "AuthorizationError";
      access = names.map((member) => (refused ? { member, status: "withheld", note: "reading it was refused" } : { member, status: "unavailable", note: "the source did not answer the probe" }));
    }
  }
  const readable = (n: string) => !access || access.find((a) => a.member === n)?.status !== "withheld";
  const stored = values.map((v) => v.name);
  const strings = values.filter((v) => v.type === "string" || v.values?.every((x) => typeof x === "string")).map((v) => v.name);
  const pick = stored.filter(readable).slice(0, 3);
  return {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    reason,
    values,
    computed: t.computed.map((c) => ({ name: c.name, type: compactType(c.schema), dependsOn: c.dependsOn })),
    relationships: t.relationships.map((r) => ({ name: r.name, target: r.target, many: r.cardinality.endsWith("-to-many") })),
    ...(visibility ? { visibility } : {}),
    ...(access ? { access } : {}),
    query: { sortable: stored, searchable: strings, filterable: "any", ...(runtime.queryLimits ? { maxLimit: runtime.queryLimits.maxLimit } : {}) },
    sdk: [`client.from(${JSON.stringify(t.name)})${pick.length ? `.select(${pick.map((p) => JSON.stringify(p)).join(", ")})` : ""}.limit(20).page()`, `client.get(${JSON.stringify(t.name)}, id)`],
    usedBy: usesOf(opts.graph, t.name),
    ...(opts.guards ? { guards: guardsOf(opts.guards) } : {}),
    ...(sample ? { examples: sample } : {})
  };
}

/** The caller's own read of one object, explained (ADR-0089); undefined when the runtime cannot explain or will not. */
async function explainOne(runtime: ContextRuntime, identity: Identity, type: string, id: string): Promise<Explanation | undefined> {
  if (!runtime.explain) return undefined;
  try {
    return await runtime.explain({ kind: "read", type, id }, identity);
  } catch {
    return undefined;
  }
}

function valueAccess(member: string, returnedOnSample: boolean, probed: number, explained: Explanation | undefined): ValueAccess {
  const finding = explained?.findings.find((f) => f.member === member);
  if (finding) {
    const why = [finding.control, finding.reason].filter(Boolean).join(": ");
    switch (finding.outcome) {
      case "returned":
        return { member, status: "verified", note: "returned" };
      case "no-value":
        return { member, status: "verified", note: "readable; no value on the probed object" };
      case "withheld":
      case "refused":
        return { member, status: "withheld", note: why || "withheld" };
      default:
        return { member, status: "unavailable", note: why || finding.outcome };
    }
  }
  if (explained?.outcome === "refused") return { member, status: "withheld", note: "reading it was refused" };
  if (returnedOnSample) return { member, status: "verified", note: "returned" };
  return { member, status: "inferred", note: `not returned on ${probed} probed` };
}

function usesOf(graph: SemanticGraph, type: string): ContextUse[] {
  const ix = indexGraph(graph);
  const id = nodeId.type(type);
  if (!ix.node(id)) return [];
  const out = new Map<string, ContextUse>();
  const add = (user: string, how: string | undefined, member?: string) => {
    const node = ix.node(user)!;
    if (node.kind !== "part" && node.kind !== "workflow" && node.kind !== "app") return;
    const owner = node.kind === "part" ? ix.node(node.parent!) : node;
    const use: ContextUse = {
      consumer: `${owner?.kind ?? "consumer"} ${owner?.label ?? ""}`.trim(),
      ...(node.kind === "part" ? { part: node.label, partKind: String(node.detail?.part ?? "part") } : {}),
      ...(member ? { member } : {}),
      ...(how ? { how } : {})
    };
    out.set(JSON.stringify(use), use);
  };
  // Direct uses, of the Type or of one of its values: each edge, so a part that uses both says so.
  for (const e of ix.in(id)) add(e.from, e.how);
  for (const c of ix.children(id)) for (const e of ix.in(c.id)) add(e.from, e.how, c.kind === "member" ? c.label : undefined);
  // And every acceptance check however far it is: a check usually reaches a Type through a page.
  for (const r of dependents(graph, id).reached) {
    if (r.distance > 1 && r.kind === "part" && ix.node(r.id)?.detail?.part === "check") add(r.id, `through ${r.path.slice(1, -1).map((p) => ix.node(p)?.label ?? p).join(", ")}`);
  }
  return [...out.values()];
}

function guardsOf(t: TypeInspection): ContextGuards {
  return {
    objectPolicy: t.objectPolicy,
    ...(t.source ? { source: t.source.dataSourceId } : {}),
    markings: t.markings,
    members: t.members.map((m) => ({
      name: m.name,
      ...(m.source ? { source: m.source.dataSourceId } : {}),
      ...(m.policy ? { policy: m.policy } : {}),
      markings: m.markings,
      ...(m.computed?.releases.length ? { releases: m.computed.releases } : {})
    }))
  };
}

async function actionEntries(runtime: ContextRuntime, identity: Identity, a: ActionDescription, reason: ContextType["reason"], needs: readonly string[]): Promise<ContextAction[]> {
  const on = a.target?.type ?? a.applicableTypes[0]!;
  let invocable = false;
  let instanceScoped = a.target !== undefined;
  try {
    const listed = (await runtime.listActions(on, identity)).find((l) => l.action.name === a.name);
    invocable = listed?.authorized ?? false;
    instanceScoped = listed?.instanceScoped ?? instanceScoped;
  } catch {
    // Not listable for this caller: not invocable.
  }
  const req = new Set(a.inputSchema.required ?? []);
  const input = Object.entries(a.inputSchema.properties ?? {})
    .map(([n, s]) => `${n}${req.has(n) ? "" : "?"}: ${compactType(s)}`)
    .join(", ");
  const effect = `${a.sideEffects === "none" ? "reads only" : a.sideEffects}; idempotency ${a.idempotency}${a.target ? `; acts on one ${a.target.type} named by ${a.target.idFrom}` : ""}`;
  const handle = `client.action(${JSON.stringify(a.name)})`;
  return [{ name: a.name, description: a.description, reason, on, invocable, instanceScoped, input: `{ ${input} }`, effect, needs, sdk: [`${handle}.preview(input)`, `${handle}.invoke(input)`] }];
}

/** The one status every value shares when it is about the Type rather than any value: a refused read, nothing to probe. */
function wholeStatus(t: ContextType): ValueAccess | undefined {
  const first = t.access?.[0];
  if (!first || first.status === "verified" || first.status === "inferred") return undefined;
  return t.access.every((a) => a.status === first.status && a.note === first.note) ? first : undefined;
}

function mark(t: ContextType, member: string): string {
  const a = t.access?.find((x) => x.member === member);
  if (!a || a.status === "verified" || wholeStatus(t)) return "";
  return a.status === "inferred" ? `  [inferred: not returned to this caller on ${t.visibility?.probed ?? 0} probed]` : `  [${a.status}: ${a.note}]`;
}

function guardOf(t: ContextType, member: string): string {
  const g = t.guards?.members.find((m) => m.name === member);
  if (!g) return "";
  const parts = [...(g.source && g.source !== t.guards!.source ? [`from ${g.source}`] : []), ...(g.policy ? [`policy ${g.policy}`] : []), ...(g.markings.length ? [`marked ${g.markings.join(", ")}`] : []), ...(g.releases ? [`released from ${g.releases.join(", ")}`] : [])];
  return parts.length ? `  {${parts.join("; ")}}` : "";
}

function renderType(t: ContextType): string {
  const lines = [`${t.name}${t.description ? ` — ${t.description}` : ""}`];
  const whole = wholeStatus(t);
  if (whole) lines.push(`  [${whole.status}: ${whole.note}, for every value]`);
  if (t.guards) lines.push(`  guarded by ${t.guards.objectPolicy}${t.guards.source ? `; read from ${t.guards.source}` : ""}${t.guards.markings.length ? `; marked ${t.guards.markings.join(", ")}` : ""}`);
  for (const v of t.values) lines.push(`  ${v.name}${v.required ? "" : "?"}: ${v.values ? v.values.map((x) => JSON.stringify(x)).join(" | ") : v.type}${v.description ? ` — ${v.description}` : ""}${mark(t, v.name)}${guardOf(t, v.name)}`);
  for (const c of t.computed) lines.push(`  ${c.name} (computed from ${c.dependsOn.join(", ")}): ${c.type}${mark(t, c.name)}${guardOf(t, c.name)}`);
  for (const r of t.relationships) lines.push(`  → ${r.name}: ${r.target}${r.many ? "[]" : ""}`);
  if (t.visibility) lines.push(`  (read as this caller: ${t.visibility.probed} probed)`);
  const shown = t.usedBy.slice(0, 8);
  for (const u of shown) lines.push(`  used by ${u.consumer}${u.part ? ` ${u.partKind} "${u.part}"` : ""}${u.member ? ` (${u.member}${u.how ? `, ${u.how}` : ""})` : u.how ? ` (${u.how})` : ""}`);
  if (t.usedBy.length > shown.length) lines.push(`  used by ${t.usedBy.length - shown.length} more`);
  for (const e of t.examples ?? []) lines.push(`  example ${e.objectId}: ${JSON.stringify(e.values)}`);
  return lines.join("\n");
}

function renderAction(a: ContextAction): string {
  return `${a.name} on ${a.on} — ${a.description}\n  input ${a.input}; ${a.effect}; ${a.invocable ? "this caller may invoke it" : a.instanceScoped ? "decided on each object: this caller is not allowed it on every one" : "this caller may not invoke it"}`;
}
