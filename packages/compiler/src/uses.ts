import type { ModelDescription } from "@typesys/core";
import type { ConsumerPart, GraphConsumer, GraphUse } from "@typesys/devkit";
import { isRef, parseRef } from "./expr.js";
import type { AppCheck, AppSpec, DataIR, EffectIR, FieldRefIR, FilterIR, FlowIR, IncludeIR, NodeIR, ReadIR, StepIR } from "./ir.js";

/** Every `$head` an expression or effect refers to. */
function refHeads(v: unknown, out = new Set<string>()): Set<string> {
  if (isRef(v)) {
    const r = parseRef(v);
    if (r) out.add(r.head);
  } else if (Array.isArray(v)) for (const x of v) refHeads(x, out);
  else if (v && typeof v === "object" && !("literal" in v)) for (const x of Object.values(v)) refHeads(x, out);
  return out;
}

const fieldName = (f: FieldRefIR) => (typeof f === "string" ? f : f.field);

function filterProperties(f: FilterIR | undefined, out: string[] = []): string[] {
  if (!f) return out;
  if ("and" in f) for (const x of f.and) filterProperties(x, out);
  else if ("or" in f) for (const x of f.or) filterProperties(x, out);
  else out.push(f.property);
  return out;
}

class Uses {
  readonly list: GraphUse[] = [];
  constructor(private readonly model: ModelDescription | undefined) {}

  targetOf(type: string, relationship: string): string | undefined {
    return this.model?.types.find((t) => t.name === type)?.relationships.find((r) => r.name === relationship)?.target;
  }

  member(type: string, member: string, how: string): void {
    // A dotted field reads the first member and goes into its value.
    this.list.push({ kind: "member", type, member: member.split(".")[0]!, how });
  }

  include(type: string, inc: IncludeIR): void {
    this.list.push({ kind: "relationship", type, relationship: inc.relationship, how: "include" });
    const target = this.targetOf(type, inc.relationship);
    if (!target) return;
    if (inc.select) for (const m of inc.select) this.member(target, m, "select");
    else this.list.push({ kind: "type", type: target, whole: true, how: "include" });
    for (const p of filterProperties(inc.filter)) this.member(target, p, "filter");
    for (const s of inc.sort ?? []) this.member(target, s.property, "sort");
    for (const i of inc.include ?? []) this.include(target, i);
  }

  /** What a read uses, and the Type its rows are, when it has one. */
  read(read: ReadIR): string | undefined {
    switch (read.kind) {
      case "query": {
        const q = read.query;
        if (q.select) {
          this.list.push({ kind: "type", type: q.type, how: "query" });
          for (const m of q.select) this.member(q.type, m, "select");
        } else this.list.push({ kind: "type", type: q.type, whole: true, how: "query" });
        for (const p of filterProperties(q.filter)) this.member(q.type, p, "filter");
        for (const s of q.sort ?? []) this.member(q.type, s.property, "sort");
        for (const p of q.search?.properties ?? []) this.member(q.type, p, "search");
        for (const i of q.include ?? []) this.include(q.type, i);
        return q.type;
      }
      case "object":
        this.list.push({ kind: "type", type: read.type, whole: true, how: "object" });
        return read.type;
      case "related": {
        this.list.push({ kind: "relationship", type: read.type, relationship: read.relationship, how: "related" });
        const target = this.targetOf(read.type, read.relationship);
        if (target) this.list.push({ kind: "type", type: target, whole: true, how: "related" });
        return target;
      }
      case "aggregate": {
        const a = read.aggregate;
        this.list.push({ kind: "type", type: a.type, how: "aggregate" });
        for (const p of filterProperties(a.filter)) this.member(a.type, p, "filter");
        for (const g of a.groupBy ?? []) this.member(a.type, g, "group");
        for (const agg of a.aggregations) if (agg.property) this.member(a.type, agg.property, "aggregate");
        return undefined;
      }
    }
  }
}

/** The Type of each piece of data's rows, where it is a direct read of one. */
type RowTypes = Map<string, string | undefined>;

function dataPart(name: string, label: string, decl: DataIR, model: ModelDescription | undefined, rows: RowTypes, partOf: (head: string) => string | undefined): ConsumerPart {
  const u = new Uses(model);
  if (decl.kind === "derive") rows.set(name, undefined);
  else rows.set(name, u.read(decl));
  for (const head of refHeads(decl)) {
    const part = partOf(head);
    if (part) u.list.push({ kind: "part", part, how: "references" });
  }
  return { name: label, kind: "data", uses: u.list };
}

function effectUses(effects: readonly EffectIR[] | undefined, u: Uses, flows: Readonly<Record<string, FlowIR>>): void {
  for (const e of effects ?? []) {
    if ("invoke" in e) u.list.push({ kind: "action", action: e.invoke, how: "invoke" });
    if ("run" in e && flows[e.run]) u.list.push({ kind: "consumer", consumer: "workflow", name: flows[e.run]!.name, how: "run" });
    if ("navigate" in e) u.list.push({ kind: "part", part: `page.${e.navigate}`, how: "navigate" });
  }
}

function nodeUses(n: NodeIR, u: Uses, dataRef: (name: string) => { part: string; type: string | undefined } | undefined, flows: Readonly<Record<string, FlowIR>>): void {
  const fields = (data: string, names: readonly string[], how: string) => {
    const d = dataRef(data);
    if (!d) return;
    u.list.push({ kind: "part", part: d.part, how: "shows" });
    if (d.type) for (const f of names) u.member(d.type, f, how);
  };
  const flow = (key: string | undefined) => {
    if (key && flows[key]) u.list.push({ kind: "consumer", consumer: "workflow", name: flows[key].name, how: "run" });
  };
  for (const head of refHeads("when" in n ? n.when : undefined)) if (dataRef(head)) u.list.push({ kind: "part", part: dataRef(head)!.part, how: "references" });
  switch (n.kind) {
    case "grid":
    case "stack":
    case "section":
      for (const c of n.children) nodeUses(c, u, dataRef, flows);
      break;
    case "tabs":
      for (const t of n.tabs) nodeUses(t.content, u, dataRef, flows);
      break;
    case "text":
    case "metric":
      for (const head of refHeads(n)) if (dataRef(head)) u.list.push({ kind: "part", part: dataRef(head)!.part, how: "shows" });
      break;
    case "chart":
      fields(n.data, [n.x, ...n.y], "chart");
      break;
    case "table":
      fields(n.data, [...n.columns.map(fieldName), ...(n.filters ?? []), ...(n.groupBy ? [n.groupBy] : [])], "column");
      effectUses(n.onSelect, u, flows);
      for (const ra of n.rowActions ?? []) effectUses(ra.do, u, flows);
      break;
    case "detail":
      fields(n.data, n.fields.map(fieldName), "field");
      break;
    case "timeline":
      fields(n.data, [n.time], "time");
      break;
    case "map":
      fields(n.data, [n.lat, n.lon], "position");
      break;
    case "provenance":
      fields(n.data, [n.property], "provenance");
      break;
    case "graph":
      if (dataRef(n.root)) u.list.push({ kind: "part", part: dataRef(n.root)!.part, how: "shows" });
      if (dataRef(n.root)?.type) for (const r of n.relationships) u.list.push({ kind: "relationship", type: dataRef(n.root)!.type!, relationship: r, how: "graph" });
      break;
    case "form":
      if (n.action) u.list.push({ kind: "action", action: n.action, how: "invoke" });
      flow(n.flow);
      effectUses(n.then, u, flows);
      break;
    case "approvals":
      for (const f of n.flows ?? Object.keys(flows)) flow(f);
      break;
    case "run":
    case "assistant":
      flow(n.flow);
      break;
    case "actions":
      for (const b of n.buttons) effectUses(b.do, u, flows);
      break;
    case "custom":
      for (const head of refHeads(n.props)) if (dataRef(head)) u.list.push({ kind: "part", part: dataRef(head)!.part, how: "props" });
      break;
  }
}

function stepParts(steps: readonly StepIR[], model: ModelDescription | undefined): ConsumerPart[] {
  const names = new Set<string>();
  const parts: ConsumerPart[] = [];
  const refs = (v: unknown, u: Uses) => {
    for (const head of refHeads(v)) if (names.has(head)) u.list.push({ kind: "part", part: head, how: "needs" });
  };
  for (const s of steps) {
    const u = new Uses(model);
    refs(s.when, u);
    switch (s.kind) {
      case "read":
        u.read(s.read);
        refs(s.read, u);
        break;
      case "parallel":
        for (const p of s.steps) {
          const pu = new Uses(model);
          pu.read(p.read);
          refs(p.read, pu);
          parts.push({ name: p.name, kind: "read", uses: pu.list });
        }
        break;
      case "forEach":
        u.read(s.read);
        refs([s.over, s.read], u);
        break;
      case "compute":
        refs(s.value, u);
        break;
      case "check":
        refs(s.assert, u);
        break;
      case "ai":
        refs(s.input, u);
        break;
      case "approval":
        u.list.push({ kind: "policy", policy: s.policy, how: "approval" });
        for (const p of s.present) if (names.has(p)) u.list.push({ kind: "part", part: p, how: "presents" });
        break;
      case "action":
        u.list.push({ kind: "action", action: s.action, how: "invoke" });
        refs(s.input, u);
        if (s.compensate) u.list.push({ kind: "action", action: s.compensate.action, how: "compensate" });
        break;
    }
    parts.push({ name: s.name, kind: s.kind, ...(s.description ? { label: s.description } : {}), uses: u.list });
    names.add(s.name);
    if (s.kind === "parallel") for (const p of s.steps) names.add(p.name);
  }
  return parts;
}

function checkUses(c: AppCheck, flows: Readonly<Record<string, FlowIR>>): GraphUse[] {
  switch (c.kind) {
    case "screen":
      return [{ kind: "part", part: `page.${c.page}`, how: "screen" }];
    case "reads":
      return [
        { kind: "type", type: c.type, how: "reads" },
        ...(c.sees ?? []).map((member): GraphUse => ({ kind: "member", type: c.type, member, how: "sees" })),
        ...(c.withheld ?? []).map((member): GraphUse => ({ kind: "member", type: c.type, member, how: "withheld" }))
      ];
    case "refused":
    case "described":
      return [{ kind: "type", type: c.type, how: c.kind }];
    case "query":
      return [{ kind: "type", type: c.query.type, how: "query" }];
    case "offered":
      return [
        { kind: "type", type: c.type, how: "offered" },
        { kind: "action", action: c.action, how: "offered" }
      ];
    case "starts":
    case "approves":
      return [{ kind: "consumer", consumer: "workflow", name: flows[c.workflow]?.name ?? c.workflow, how: c.kind }];
  }
}

/**
 * What an application uses, for the dependency graph (ADR-0090): the
 * application with its data, pages and acceptance checks as parts, and
 * each flow as a workflow within it. Member-level uses come from the
 * reads' selects, filters and sorts and from the fields its components
 * show; a read with no `select` uses its whole Type. With the model, a
 * relationship's target Type is resolved too.
 */
export function appUses(app: AppSpec, model?: ModelDescription): GraphConsumer[] {
  const flows = app.flows ?? {};
  const rows: RowTypes = new Map();
  const parts: ConsumerPart[] = [];
  const appData = Object.keys(app.data ?? {});
  for (const [name, decl] of Object.entries(app.data ?? {})) parts.push(dataPart(name, `data.${name}`, decl, model, rows, (h) => (appData.includes(h) ? `data.${h}` : undefined)));
  for (const page of app.pages) {
    const local = Object.keys(page.data ?? {});
    const partOf = (h: string) => (local.includes(h) ? `page.${page.name}.data.${h}` : appData.includes(h) ? `data.${h}` : undefined);
    const pageRows: RowTypes = new Map(rows);
    for (const [name, decl] of Object.entries(page.data ?? {})) parts.push(dataPart(name, `page.${page.name}.data.${name}`, decl, model, pageRows, partOf));
    const u = new Uses(model);
    const dataRef = (name: string) => {
      const part = partOf(name);
      return part ? { part, type: pageRows.get(name) } : undefined;
    };
    for (const name of local) u.list.push({ kind: "part", part: `page.${page.name}.data.${name}`, how: "reads" });
    nodeUses(page.layout, u, dataRef, flows);
    parts.push({ name: `page.${page.name}`, kind: "page", label: page.title, uses: u.list });
  }
  for (const c of app.acceptance) parts.push({ name: `check.${c.id}`, kind: "check", ...(c.because ? { label: c.because } : {}), uses: checkUses(c, flows) });
  const consumers: GraphConsumer[] = [{ kind: "app", name: app.name, uses: [], parts }];
  for (const flow of Object.values(flows)) {
    consumers.push({
      kind: "workflow",
      name: flow.name,
      version: flow.version,
      within: app.name,
      uses: [{ kind: "policy", policy: flow.startPolicy, how: "start" }, ...(flow.cancelPolicy ? [{ kind: "policy" as const, policy: flow.cancelPolicy, how: "cancel" }] : [])],
      parts: stepParts(flow.steps, model)
    });
  }
  return consumers;
}
