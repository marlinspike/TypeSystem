import { createHash } from "node:crypto";
import { canonical, type ActionDescription, type Identity, type ModelDescription, type SemanticRuntime, type TypeDescription } from "@typesys/core";
import { compactType } from "./catalog.js";
import { discover } from "./discover.js";

export const CONTEXT_FORMAT = "typesys.context/1";

/** What compiling a context needs of a runtime: the calls a caller's own client would make. */
export type ContextRuntime = Pick<SemanticRuntime, "describeModel" | "query" | "listActions">;

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
}

/**
 * A model context compiled for one coding task and one caller (ADR-0078):
 * the part of the governed model the task needs, as that caller is told
 * of it and returned it, small enough to put in a prompt. It is decided by
 * the runtime, so a coding agent is never told of a Type its caller may not
 * learn of, nor shown a value its caller may not read.
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
  /** The context as text for a prompt. */
  readonly text: string;
  readonly tokens: number;
  /** sha256 of the rendered text: the same model, caller and task compile to the same context. */
  readonly digest: string;
}

const estimate = (text: string) => Math.ceil(text.length / 4);

const GUIDANCE = [
  "Read and change data only through TypeSystem: the runtime's API, the typed SDK, or MCP. Never query a source system directly; its rows are not governed.",
  "Values a caller may not read are left out of what they are returned, not set to null. Write code that treats any value as possibly absent.",
  "Changes happen only through Actions. An Action can be refused for one object while allowed on others; check the result.",
  "A refusal is a decision, not an error to retry or work around."
];

/** Compiles the context `options.task` needs, as `identity` is told of the model and returned its objects. */
export async function compileContext(runtime: ContextRuntime, identity: Identity, options: ContextOptions): Promise<CompiledContext> {
  const model: ModelDescription = await runtime.describeModel(identity);
  const typeByName = new Map(model.types.map((t) => [t.name, t]));
  const actionByName = new Map(model.actions.map((a) => [a.name, a]));

  // Most relevant first: what the caller asked for, then what the task's words find, then what those relate to.
  const order: { name: string; kind: "type" | "action"; reason: ContextType["reason"] }[] = [];
  const seen = new Set<string>();
  const add = (name: string, reason: ContextType["reason"]) => {
    if (seen.has(name)) return;
    const kind = typeByName.has(name) ? "type" : actionByName.has(name) ? "action" : undefined;
    if (!kind) return;
    seen.add(name);
    order.push({ name, kind, reason });
  };
  for (const f of options.focus ?? []) add(f, "focus");
  const matches = discover(model, options.task, { limit: model.types.length + model.actions.length });
  for (const m of matches) add(m.name, "task");
  if (matches.length === 0 && (options.focus ?? []).length === 0) for (const t of model.types) add(t.name, "task");
  for (const o of [...order]) {
    if (o.kind === "type") {
      for (const r of typeByName.get(o.name)!.relationships) add(r.target, "related");
      for (const a of typeByName.get(o.name)!.actions) add(a, "action");
    } else for (const t of actionByName.get(o.name)!.applicableTypes) add(t, "related");
  }

  const probe = options.probe ?? 3;
  const types: ContextType[] = [];
  const actions: ContextAction[] = [];
  const omitted: string[] = [];
  const budget = options.maxTokens ?? 4_000;
  let used = estimate(header(options.task, identity)) + estimate(GUIDANCE.join("\n"));
  for (const o of order) {
    const entry = o.kind === "type" ? await typeEntry(runtime, identity, typeByName.get(o.name)!, o.reason, probe, options.examples ?? 0) : await actionEntries(runtime, identity, actionByName.get(o.name)!, o.reason);
    const text = o.kind === "type" ? renderType(entry as ContextType) : (entry as ContextAction[]).map(renderAction).join("\n");
    if (used + estimate(text) > budget) {
      omitted.push(o.name);
      continue;
    }
    used += estimate(text);
    if (o.kind === "type") types.push(entry as ContextType);
    else actions.push(...(entry as ContextAction[]));
  }

  let task = options.task;
  const render = () =>
    [header(task, identity), "", "TYPES", ...types.map(renderType), "", "ACTIONS", ...(actions.length ? actions.map(renderAction) : ["  (none)"]), "", "RULES", ...GUIDANCE.map((g) => `- ${g}`), ...(omitted.length ? ["", `LEFT OUT to stay within ${budget} tokens: ${omitted.join(", ")}`] : [])].join("\n");
  // The headings and the list of what was left out count too: drop the least relevant until the whole fits.
  let text = render();
  while (estimate(text) > budget && types.length + actions.length > 0) {
    const last = order.filter((o) => types.some((t) => t.name === o.name) || actions.some((a) => a.name === o.name)).at(-1)!;
    if (last.kind === "type") types.splice(types.findIndex((t) => t.name === last.name), 1);
    else actions.splice(actions.findIndex((a) => a.name === last.name), 1);
    omitted.push(last.name);
    const rank = new Map(order.map((o, i) => [o.name, i]));
    omitted.sort((a, b) => rank.get(a)! - rank.get(b)!);
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
    omitted,
    text,
    tokens: estimate(text),
    digest: `sha256:${createHash("sha256").update(canonical({ text })).digest("hex")}`
  };
}

function header(task: string, identity: Identity): string {
  return `TypeSystem model context for: ${task}\nAs ${identity.subjectId}${identity.audience ? `, reading for ${identity.audience.id}` : ""}. Only what this caller is told of and returned is shown.`;
}

async function typeEntry(runtime: ContextRuntime, identity: Identity, t: TypeDescription, reason: ContextType["reason"], probe: number, examples: number): Promise<ContextType> {
  const required = new Set(t.required);
  const values = Object.entries(t.properties).map(([name, s]) => ({
    name,
    type: compactType(s),
    required: required.has(name),
    ...(s.description ? { description: s.description } : {}),
    ...(Array.isArray(s.enum) ? { values: s.enum } : {})
  }));
  let visibility: ContextType["visibility"];
  let sample: ContextType["examples"];
  if (probe > 0) {
    try {
      const items = (await runtime.query({ type: t.name, limit: probe }, identity)).items;
      if (items.length > 0) {
        const returned = new Set(items.flatMap((o) => Object.keys(o.values)));
        // Computed values are observed like any other (ADR-0078): one can be withheld while what it depends on is not, and the reverse.
        const names = [...values.map((v) => v.name), ...t.computed.map((c) => c.name)];
        visibility = { probed: items.length, returned: names.filter((n) => returned.has(n)), neverReturned: names.filter((n) => !returned.has(n)) };
        if (examples > 0) sample = items.slice(0, examples).map((o) => ({ objectId: o.objectId, values: o.values }));
      }
    } catch {
      // Refused or unavailable: the context says nothing about visibility, which is what the caller would learn.
    }
  }
  return {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    reason,
    values,
    computed: t.computed.map((c) => ({ name: c.name, type: compactType(c.schema), dependsOn: c.dependsOn })),
    relationships: t.relationships.map((r) => ({ name: r.name, target: r.target, many: r.cardinality.endsWith("-to-many") })),
    ...(visibility ? { visibility } : {}),
    ...(sample ? { examples: sample } : {})
  };
}

async function actionEntries(runtime: ContextRuntime, identity: Identity, a: ActionDescription, reason: ContextType["reason"]): Promise<ContextAction[]> {
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
  return [{ name: a.name, description: a.description, reason, on, invocable, instanceScoped, input: `{ ${input} }`, effect }];
}

function renderType(t: ContextType): string {
  const vis = t.visibility ? new Set(t.visibility.neverReturned) : undefined;
  const lines = [`${t.name}${t.description ? ` — ${t.description}` : ""}`];
  for (const v of t.values) lines.push(`  ${v.name}${v.required ? "" : "?"}: ${v.values ? v.values.map((x) => JSON.stringify(x)).join(" | ") : v.type}${v.description ? ` — ${v.description}` : ""}${vis?.has(v.name) ? "  [not returned to this caller]" : ""}`);
  for (const c of t.computed) lines.push(`  ${c.name} (computed from ${c.dependsOn.join(", ")}): ${c.type}${vis?.has(c.name) ? "  [not returned to this caller]" : ""}`);
  for (const r of t.relationships) lines.push(`  → ${r.name}: ${r.target}${r.many ? "[]" : ""}`);
  if (t.visibility) lines.push(`  (read as this caller: ${t.visibility.probed} probed)`);
  for (const e of t.examples ?? []) lines.push(`  example ${e.objectId}: ${JSON.stringify(e.values)}`);
  return lines.join("\n");
}

function renderAction(a: ContextAction): string {
  return `${a.name} on ${a.on} — ${a.description}\n  input ${a.input}; ${a.effect}; ${a.invocable ? "this caller may invoke it" : a.instanceScoped ? "decided on each object: this caller is not allowed it on every one" : "this caller may not invoke it"}`;
}
