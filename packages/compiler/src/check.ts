import { canonical, type Audience, type JsonSchema2020, type ModelDescription, type TypeDescription, type ActionDescription } from "@typesys/core";
import { didYouMean, validateQuery } from "@typesys/devkit";
import { validateWorkflow } from "@typesys/workflow";
import { Diagnostics, pointer, type AppDiagnostic } from "./diagnostics.js";
import { alwaysFalse, checkExpr, extend, isFnCall, isLiteral, isRef, parseRef, walk, type Scope } from "./expr.js";
import type { AppSpec, DataIR, EffectIR, Expr, FieldRefIR, FilterIR, FlowIR, FnCall, IncludeIR, NodeIR, PageIR, QueryIR, ReadIR, StateIR, StepIR } from "./ir.js";
import { appProblems } from "./parse.js";
import { engineNames, lowerSteps, skeleton, type LoweredStep } from "./skeleton.js";
import { BOOLEAN, INTEGER, NUMBER, STRING, UNKNOWN, assignable, carrying, describe, groupTy, mayBeUnknown, rowTy, schemaToTy, type Field, type Ty, type Typed } from "./types.js";

/**
 * What the checker needs to know beyond the spec (ADR-0080): the model as
 * its author sees it, and, when a host is loaded, the runtime's own answers
 * for each caller. Every question is one the runtime decides; the checker
 * only asks it early.
 */
export interface CheckEnvironment {
  readonly model: ModelDescription;
  /** The model as each caller is told of it (ADR-0068); undefined when the caller is refused a description. */
  describedTo?(caller: string): Promise<ModelDescription | undefined>;
  /** Whether a policy admits a caller for a resource, as the workflow engine will ask it. */
  admits?(policy: string, resource: { typeName: string; actionName: string }, caller: string): Promise<boolean>;
  /** The model as a caller bound to a model's audience is told of it (ADR-0067). */
  describedToAudience?(caller: string, audience: Audience): Promise<ModelDescription | undefined>;
  /** The application's configured models by id (ADR-0074). Absent: the LLM configuration was not read. */
  readonly models?: Readonly<Record<string, { readonly uses: readonly string[]; readonly audience?: Audience }>>;
  /** Whether `src/extensions/<module>` exists. Absent: not checked. */
  extensionExists?(module: string): boolean;
}

/** Data, typed, and what they depend on. */
export interface DataInfo {
  readonly name: string;
  readonly decl: DataIR;
  readonly typed: Typed;
  /** Other data, state and parameters it references: what makes it read again. */
  readonly deps: { readonly data: readonly string[]; readonly state: readonly string[]; readonly params: readonly string[] };
  /** Types it reads through the runtime: an Action or run that changes one reads it again. */
  readonly types: readonly string[];
}

export interface FlowInfo {
  readonly key: string;
  readonly flow: FlowIR;
  readonly lowered: readonly LoweredStep[];
  /** Each step's output type, by IR name. */
  readonly outputs: ReadonlyMap<string, Typed>;
  readonly input: Extract<Ty, { t: "object" }>;
  /** Types the flow's reads read, and Types its Actions apply to. */
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  /** Who of the application's callers each policy admits, when a host was loaded. */
  readonly admitted?: { readonly start: readonly string[]; readonly approvals: Readonly<Record<string, readonly string[]>> };
}

/** A handwritten function's contract: what the generated `contracts.ts` declares and tsc holds the extension to. */
export interface FnContract {
  readonly fn: string;
  readonly module: string;
  readonly export: string;
  readonly args: Readonly<Record<string, Typed>>;
  readonly returns: Ty;
}

export interface ComponentContract {
  readonly component: string;
  readonly module: string;
  readonly export: string;
  readonly props: Readonly<Record<string, Ty>>;
}

export interface PageInfo {
  readonly page: PageIR;
  readonly data: Readonly<Record<string, DataInfo>>;
  readonly state: Readonly<Record<string, StateIR>>;
}

/** The checked application: everything the compiler generates from, already typed. */
export interface AppAnalysis {
  readonly app: AppSpec;
  readonly ok: boolean;
  readonly diagnostics: readonly AppDiagnostic[];
  readonly model: ModelDescription;
  readonly data: Readonly<Record<string, DataInfo>>;
  readonly state: Readonly<Record<string, StateIR>>;
  readonly pages: readonly PageInfo[];
  readonly flows: Readonly<Record<string, FlowInfo>>;
  readonly fns: Readonly<Record<string, FnContract>>;
  readonly components: Readonly<Record<string, ComponentContract>>;
  /** Actions any interface or flow invokes. */
  readonly actions: readonly string[];
}

const TONE_VALUES = ["neutral", "info", "good", "warn", "bad"];
const ME: Typed = { ty: { t: "object", fields: { subjectId: { ty: STRING, optional: false }, roles: { ty: { t: "list", of: STRING }, optional: false } } } };
const APPROVAL_OUTPUT: Ty = { t: "object", fields: { approved: { ty: BOOLEAN, optional: false }, comment: { ty: STRING, optional: true } } };
const RUN_ID: Ty = STRING;

/**
 * Checks an application against its model (ADR-0080): every reference,
 * field, type, relationship, Action and flow, every data dependency and step
 * order, every expression's type, every Action's input, and the governance
 * rules: an AI proposal reviewed before it acts, an effect previewed and
 * confirmed, a retry only of what may be repeated, a model told of what it
 * is sent. Static checks complement the runtime's enforcement; they never
 * replace it.
 */
export async function checkApp(doc: unknown, env: CheckEnvironment): Promise<AppAnalysis> {
  const structural = appProblems(doc);
  const app = doc as AppSpec;
  const empty = { data: {}, state: {}, pages: [], flows: {}, fns: {}, components: {}, actions: [] };
  if (structural.length > 0) return { app, ok: false, diagnostics: structural, model: env.model, ...empty };
  return new Checker(app, env).run();
}

class Checker {
  private readonly d = new Diagnostics();
  private readonly types: Map<string, TypeDescription>;
  private readonly actionsByName: Map<string, ActionDescription>;
  private readonly fns = new Map<string, FnContract>();
  private readonly components = new Map<string, ComponentContract>();
  private readonly actionsUsed = new Set<string>();
  private readonly flows = new Map<string, FlowInfo>();

  constructor(
    private readonly app: AppSpec,
    private readonly env: CheckEnvironment
  ) {
    this.types = new Map(env.model.types.map((t) => [t.name, t]));
    this.actionsByName = new Map(env.model.actions.map((a) => [a.name, a]));
  }

  async run(): Promise<AppAnalysis> {
    const app = this.app;
    // Flows first: the interface refers to them, never the other way round.
    for (const [key, flow] of Object.entries(app.flows ?? {})) this.flows.set(key, this.flow(key, flow, pointer("flows", key)));
    await this.governFlows();

    const appState = app.state ?? {};
    const appData = this.datas(app.data ?? {}, "/data", appState, {}, {});
    const pages: PageInfo[] = [];
    const pageNames = new Set(app.pages.map((p) => p.name));
    for (const [i, page] of app.pages.entries()) {
      const at = pointer("pages", i);
      for (const k of Object.keys(page.state ?? {})) if (Object.hasOwn(appState, k)) this.d.error("duplicate-name", `${at}/state/${k}`, `state "${k}" is already the application's`, "rename one: $state.<name> must name one value");
      for (const k of Object.keys(page.data ?? {})) if (Object.hasOwn(app.data ?? {}, k)) this.d.error("duplicate-name", `${at}/data/${k}`, `data "${k}" are already the application's`, "rename one");
      for (const caller of page.for ?? []) if (!Object.hasOwn(app.callers, caller)) this.d.error("unknown-reference", `${at}/for`, `"${caller}" is not one of the application's callers`, `callers: ${Object.keys(app.callers).join(", ")}`);
      const state = { ...appState, ...(page.state ?? {}) };
      const data = { ...appData, ...this.datas(page.data ?? {}, `${at}/data`, state, page.params ?? {}, appData) };
      const scope = this.uiScope(state, page.params ?? {}, data);
      this.node(page.layout, `${at}/layout`, scope, data, state, pageNames);
      pages.push({ page, data, state });
      this.unused(page, data, appData, at);
    }
    this.acceptance(pageNames);

    const diagnostics = this.d.list;
    return {
      app,
      ok: !diagnostics.some((x) => x.severity === "error"),
      diagnostics,
      model: this.env.model,
      data: appData,
      state: appState,
      pages,
      flows: Object.fromEntries(this.flows),
      fns: Object.fromEntries(this.fns),
      components: Object.fromEntries(this.components),
      actions: [...this.actionsUsed].sort()
    };
  }

  // -------------------------------------------------------------------------
  // The model
  // -------------------------------------------------------------------------

  private type(name: string, at: string): TypeDescription | undefined {
    const t = this.types.get(name);
    if (!t) {
      const near = didYouMean(name, this.types.keys());
      this.d.error("unknown-type", at, `No Type "${name}" in the model`, near ? `did you mean "${near}"?` : `Types: ${[...this.types.keys()].join(", ")}`);
    }
    return t;
  }

  private action(name: string, at: string): ActionDescription | undefined {
    const a = this.actionsByName.get(name);
    if (!a) {
      const near = didYouMean(name, this.actionsByName.keys());
      this.d.error("unknown-action", at, `No Action "${name}" in the model`, near ? `did you mean "${near}"?` : `Actions: ${[...this.actionsByName.keys()].join(", ") || "none"}`);
    } else this.actionsUsed.add(name);
    return a;
  }

  private memberTy(t: TypeDescription, name: string): Ty | undefined {
    if (Object.hasOwn(t.properties, name)) return schemaToTy(t.properties[name]).ty;
    const c = t.computed.find((x) => x.name === name);
    return c ? schemaToTy(c.schema).ty : undefined;
  }

  private member(t: TypeDescription, name: string, at: string): Ty | undefined {
    const ty = this.memberTy(t, name);
    if (ty === undefined) {
      const all = [...Object.keys(t.properties), ...t.computed.map((c) => c.name)];
      const near = didYouMean(name, all);
      this.d.error("unknown-field", at, `${t.name} has no field "${name}"`, near ? `did you mean "${near}"?` : `its fields are ${all.join(", ")}`);
    }
    return ty;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Types one read, in `scope`; `inFlow` reads an object that must exist, so it is never null. */
  private read(r: ReadIR, scope: Scope, at: string, inFlow: boolean): { typed: Typed; types: string[] } {
    const fail = { typed: { ty: UNKNOWN }, types: [] };
    switch (r.kind) {
      case "query": {
        const t = this.type(r.query.type, `${at}/query/type`);
        if (!t) return fail;
        const deps: Typed[] = [];
        if (r.query.filter) this.filter(r.query.filter, t, scope, `${at}/query/filter`, deps);
        if (r.query.search) {
          const s = checkExpr(r.query.search.text, scope, `${at}/query/search/text`, this.d);
          if (s.ty.t !== "string" && s.ty.t !== "unknown") this.d.error("type-mismatch", `${at}/query/search/text`, `search text is a string, and this is ${describe(s.ty)}`);
          deps.push(s);
        }
        for (const [i, f] of (r.query.select ?? []).entries()) this.member(t, f, `${at}/query/select/${i}`);
        for (const [i, k] of (r.query.sort ?? []).entries()) if (this.memberTy(t, k.property) === undefined) this.member(t, k.property, `${at}/query/sort/${i}/property`);
        this.validateQuery(r.query, `${at}/query`);
        const types = [t.name];
        const includes = this.includes(t, r.query.include ?? [], `${at}/query/include`, scope, types);
        const row = rowTy(t, r.query.select, includes);
        return { typed: carrying({ t: "list", of: row }, ...deps.map((x) => ({ ...x, withheld: false, nullable: false }))), types };
      }
      case "object": {
        const t = this.type(r.type, `${at}/type`);
        const id = checkExpr(r.id, scope, `${at}/id`, this.d);
        if (id.ty.t !== "string" && id.ty.t !== "unknown") this.d.error("type-mismatch", `${at}/id`, `an object id is a string, and this is ${describe(id.ty)}`);
        if (!t) return fail;
        // In the interface an object is absent until its id is known (nothing selected yet); in a flow a missing one fails the step.
        return { typed: { ty: rowTy(t, undefined), ...(inFlow ? (id.skippedBy?.length ? { skippedBy: id.skippedBy } : {}) : { nullable: true }) }, types: [t.name] };
      }
      case "related": {
        const t = this.type(r.type, `${at}/type`);
        const of = checkExpr(r.of, scope, `${at}/of`, this.d);
        if (of.ty.t !== "string" && of.ty.t !== "unknown") this.d.error("type-mismatch", `${at}/of`, `of is the object's id, a string, and this is ${describe(of.ty)}`, 'e.g. "$shipment.$id"');
        if (!t) return fail;
        const rel = t.relationships.find((x) => x.name === r.relationship);
        if (!rel) {
          const near = didYouMean(r.relationship, t.relationships.map((x) => x.name));
          this.d.error("unknown-relationship", `${at}/relationship`, `${t.name} has no relationship "${r.relationship}"`, near ? `did you mean "${near}"?` : `its relationships are ${t.relationships.map((x) => x.name).join(", ") || "none"}`);
          return fail;
        }
        const target = this.types.get(rel.target);
        if (!target) return fail;
        return { typed: { ty: { t: "list", of: rowTy(target, undefined) }, ...(of.skippedBy?.length ? { skippedBy: of.skippedBy } : {}) }, types: [t.name, target.name] };
      }
      case "aggregate": {
        const a = r.aggregate;
        const t = this.type(a.type, `${at}/aggregate/type`);
        if (!t) return fail;
        if (a.filter) this.filter(a.filter, t, scope, `${at}/aggregate/filter`, []);
        for (const [i, g] of (a.groupBy ?? []).entries()) {
          const gat = `${at}/aggregate/groupBy/${i}`;
          if (t.computed.some((c) => c.name === g)) this.d.error("unsupported", gat, `${t.name}.${g} is computed, and an aggregate groups in the source`, "group by a stored property");
          else if (!Object.hasOwn(t.properties, g)) this.member(t, g, gat);
        }
        const names = new Set<string>();
        for (const [i, agg] of a.aggregations.entries()) {
          const aat = `${at}/aggregate/aggregations/${i}`;
          if (names.has(agg.name)) this.d.error("duplicate-name", `${aat}/name`, `aggregation "${agg.name}" is named twice`);
          names.add(agg.name);
          if (!["count", "sum", "avg", "min", "max"].includes(agg.op)) this.d.error("invalid-app", `${aat}/op`, "op is count, sum, avg, min or max");
          if (agg.property === undefined) {
            if (agg.op !== "count") this.d.error("invalid-app", `${aat}/property`, `${agg.op} needs a property`);
            continue;
          }
          if (t.computed.some((c) => c.name === agg.property)) {
            this.d.error("unsupported", `${aat}/property`, `${t.name}.${agg.property} is computed, and an aggregate runs in the source`);
            continue;
          }
          const ty = this.member(t, agg.property, `${aat}/property`);
          if (ty && agg.op !== "count" && ty.t !== "number") this.d.error("type-mismatch", `${aat}/property`, `${agg.op} adds up numbers, and ${t.name}.${agg.property} is ${describe(ty)}`);
        }
        return { typed: { ty: { t: "list", of: groupTy(t, a.groupBy ?? [], a.aggregations.map((x) => x.name)) } }, types: [t.name] };
      }
    }
  }

  /** A query's filter: each property exists, each value has the property's type, and each operator applies to it. */
  private filter(f: FilterIR, t: TypeDescription, scope: Scope, at: string, deps: Typed[]): void {
    if ("and" in f || "or" in f) {
      const parts = "and" in f ? f.and : f.or;
      const key = "and" in f ? "and" : "or";
      if (!Array.isArray(parts) || parts.length === 0) return this.d.error("invalid-app", `${at}/${key}`, `${key} lists at least one condition`);
      parts.forEach((p: FilterIR, i) => this.filter(p, t, scope, `${at}/${key}/${i}`, deps));
      return;
    }
    const prop = this.member(t, f.property, `${at}/property`);
    const v = checkExpr(f.value, scope, `${at}/value`, this.d);
    deps.push(v);
    if (!prop) return;
    const want: Ty | undefined =
      f.operator === "in" ? { t: "list", of: prop } : f.operator === "contains" ? (prop.t === "list" ? prop.of : undefined) : f.operator === "icontains" ? STRING : prop;
    if (want === undefined) return this.d.error("type-mismatch", `${at}/operator`, `contains looks in a list, and ${t.name}.${f.property} is ${describe(prop)}`);
    if (["gt", "gte", "lt", "lte"].includes(f.operator) && prop.t !== "number" && !(prop.t === "string" && (prop.format === "date-time" || prop.format === "date")))
      return this.d.error("not-comparable", `${at}/operator`, `${f.operator} orders numbers and dates, and ${t.name}.${f.property} is ${describe(prop)}`);
    const why = assignable(v.ty, want);
    if (why) this.d.error(why.includes("not one of") ? "not-in-enum" : "type-mismatch", `${at}/value`, `${t.name}.${f.property} ${f.operator} expects ${describe(want)}: ${why}`, "nothing is converted: give a value of the property's type");
  }

  /** The runtime's own query check (devkit, ADR-0056), on the query with each expression replaced by a value of its property's type. */
  private validateQuery(q: QueryIR, at: string): void {
    const t = this.types.get(q.type);
    const sample = (prop: string, op: string): unknown => {
      const s = t?.properties[prop] ?? t?.computed.find((c) => c.name === prop)?.schema;
      const one = sampleOf(s);
      return op === "in" ? [one] : op === "contains" ? (Array.isArray(one) ? one[0] : one) : one;
    };
    const plain = (f: FilterIR): unknown =>
      "and" in f ? { and: f.and.map(plain) } : "or" in f ? { or: f.or.map(plain) } : { property: f.property, operator: f.operator, value: isLiteral(f.value) ? f.value.literal : isRef(f.value) || isOperation(f.value) ? sample(f.property, f.operator) : f.value };
    const inc = (i: IncludeIR): unknown => ({ ...i, ...(i.filter ? { filter: plain(i.filter) } : {}), ...(i.include ? { include: i.include.map(inc) } : {}) });
    const query = {
      type: q.type,
      ...(q.filter ? { filter: plain(q.filter) } : {}),
      ...(q.search ? { search: { text: "x", ...(q.search.properties ? { properties: [...q.search.properties] } : {}) } } : {}),
      ...(q.sort ? { sort: q.sort } : {}),
      ...(q.select ? { select: q.select } : {}),
      ...(q.include ? { include: q.include.map(inc) } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {})
    };
    for (const x of validateQuery(this.env.model, query)) {
      // Unknown fields and types are reported once, by this checker, with its own hints.
      if (x.code === "unknown-property" || x.code === "unknown-type") continue;
      this.d.add(x.code === "unknown-relationship" ? "unknown-relationship" : "query", `${at}${x.path}`, x.message, { severity: x.severity, hint: x.suggestion ? `did you mean "${x.suggestion}"?` : undefined });
    }
  }

  private includes(t: TypeDescription, includes: readonly IncludeIR[], at: string, scope: Scope, types: string[]): Record<string, Ty> {
    const out: Record<string, Ty> = {};
    for (const [i, inc] of includes.entries()) {
      const rel = t.relationships.find((r) => r.name === inc.relationship);
      if (!rel) continue; // reported by validateQuery
      const target = this.types.get(rel.target);
      if (!target) continue;
      types.push(target.name);
      if (inc.filter) this.filter(inc.filter, target, scope, `${at}/${i}/filter`, []);
      for (const [j, f] of (inc.select ?? []).entries()) this.member(target, f, `${at}/${i}/select/${j}`);
      out[inc.relationship] = { t: "list", of: rowTy(target, inc.select, this.includes(target, inc.include ?? [], `${at}/${i}/include`, scope, types)) };
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private datas(decls: Readonly<Record<string, DataIR>>, at: string, state: Readonly<Record<string, StateIR>>, params: NonNullable<PageIR["params"]>, outer: Readonly<Record<string, DataInfo>>): Record<string, DataInfo> {
    const out: Record<string, DataInfo> = {};
    const names = Object.keys(decls);
    const deps = new Map<string, Set<string>>();
    // Typed in dependency order, so data that use other data see them typed; a cycle is reported, never looped on.
    const order = this.dataOrder(decls, at, deps, outer);
    for (const name of order) {
      const decl = decls[name]!;
      const dat = `${at}/${name}`;
      const used = { data: new Set<string>(), state: new Set<string>(), params: new Set<string>() };
      const base = this.uiScope(state, params, { ...outer, ...out });
      const scope: Scope = {
        ...base,
        refuse: (head) => (names.includes(head) && !Object.hasOwn(out, head) && head !== name ? { code: "cyclic-dependency", message: `"$${head}" is part of a dependency cycle` } : head === name ? { code: "cyclic-dependency", message: `data "${name}" refer to themselves` } : undefined),
        onRef: (head, path) => {
          if (head === "state" && path[0]) used.state.add(path[0]);
          else if (head === "params" && path[0]) used.params.add(path[0]);
          else if (head !== "me") used.data.add(head);
        }
      };
      let typed: Typed;
      let types: string[] = [];
      if (decl.kind === "derive") typed = checkExpr(decl.value, scope, `${dat}/value`, this.d);
      else ({ typed, types } = this.read(decl, scope, dat, false));
      out[name] = { name, decl, typed, deps: { data: [...used.data], state: [...used.state], params: [...used.params] }, types };
    }
    return out;
  }

  /** Data names in an order where each comes after what it references; a cycle is reported with its members. */
  private dataOrder(decls: Readonly<Record<string, DataIR>>, at: string, deps: Map<string, Set<string>>, outer: Readonly<Record<string, DataInfo>>): string[] {
    const names = Object.keys(decls);
    for (const n of names) {
      const refs = new Set<string>();
      const visit = (x: unknown) => {
        if (typeof x === "string") {
          const r = isRef(x) ? parseRef(x) : undefined;
          if (r && names.includes(r.head) && !Object.hasOwn(outer, r.head)) refs.add(r.head);
        } else if (Array.isArray(x)) x.forEach(visit);
        else if (x && typeof x === "object" && !isLiteral(x)) Object.values(x as Record<string, unknown>).forEach(visit);
      };
      visit(decls[n]);
      deps.set(n, refs);
    }
    const order: string[] = [];
    const state = new Map<string, "visiting" | "done">();
    const reported = new Set<string>();
    const visit = (n: string, path: string[]) => {
      if (state.get(n) === "done") return;
      if (state.get(n) === "visiting") {
        const cycle = [...path.slice(path.indexOf(n)), n];
        const key = [...cycle].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          this.d.error("cyclic-dependency", `${at}/${n}`, `data depend on each other in a cycle: ${cycle.join(" → ")}`, "one of them must depend only on state, parameters or other data", "none of them can be read first");
        }
        return;
      }
      state.set(n, "visiting");
      for (const dep of deps.get(n) ?? []) visit(dep, [...path, n]);
      state.set(n, "done");
      order.push(n);
    };
    for (const n of names) visit(n, []);
    return order;
  }

  private uiScope(state: Readonly<Record<string, StateIR>>, params: NonNullable<PageIR["params"]>, data: Readonly<Record<string, DataInfo>>): Scope {
    const stateTy: Ty = { t: "object", fields: Object.fromEntries(Object.entries(state).map(([k, s]) => [k, stateField(s)])) };
    const paramTy: Ty = { t: "object", fields: Object.fromEntries(Object.entries(params).map(([k, p]) => [k, { ty: schemaToTy(p.schema).ty, optional: false }])) };
    return {
      mode: "ui",
      lookup: (head) => {
        if (head === "state") return { ty: stateTy };
        if (head === "params") return { ty: paramTy };
        if (head === "me") return ME;
        return Object.hasOwn(data, head) ? data[head]!.typed : undefined;
      },
      names: () => ["state", "params", "me", ...Object.keys(data)],
      onFn: (call, args, at) => this.fn(call, args, at)
    };
  }

  private unused(page: PageIR, data: Readonly<Record<string, DataInfo>>, appData: Readonly<Record<string, DataInfo>>, at: string): void {
    const text = JSON.stringify(page.layout);
    const usedBy = new Set<string>();
    for (const info of Object.values(data)) for (const dep of info.deps.data) usedBy.add(dep);
    for (const name of Object.keys(page.data ?? {})) {
      const referenced = new RegExp(`"(\\$${name}([."]|$)|${name}")`).test(text) || usedBy.has(name);
      if (!referenced) this.d.warn("unused-data", pointer(...at.slice(1).split("/"), "data", name), `data "${name}" are read and never shown or used`, "remove them, or use them", "every read is a governed call, decided and audited");
    }
    void appData;
  }

  // -------------------------------------------------------------------------
  // Flows
  // -------------------------------------------------------------------------

  private flow(key: string, flow: FlowIR, at: string): FlowInfo {
    const inputFields: Record<string, Field> = {};
    for (const [k, v] of Object.entries(flow.input)) {
      inputFields[k] = { ty: schemaToTy(v.schema).ty, optional: false };
      if (v.objectOf) this.type(v.objectOf, `${at}/input/${k}/objectOf`);
    }
    const input: Extract<Ty, { t: "object" }> = { t: "object", fields: inputFields };
    const outputs = new Map<string, Typed>();
    const conditions = new Map<string, Expr | undefined>();
    const all = new Set(flow.steps.flatMap((s) => (s.kind === "parallel" ? [s.name, ...s.steps.map((r) => r.name)] : [s.name])));
    const reads = new Set<string>();
    const writes = new Set<string>();
    const kinds = new Map(flow.steps.flatMap((s) => (s.kind === "parallel" ? s.steps.map((r) => [r.name, "read"] as const) : [[s.name, s.kind] as const])));
    const scopeFor = (current: string, extra: Record<string, Typed> = {}, siblings: readonly string[] = []): Scope => ({
      mode: "flow",
      lookup: (head) => (head === "input" ? { ty: input } : Object.hasOwn(extra, head) ? extra[head] : outputs.get(head)),
      names: () => ["input", ...Object.keys(extra), ...outputs.keys()],
      refuse: (head) => {
        if (head === "input" || Object.hasOwn(extra, head) || outputs.has(head)) {
          if (kinds.get(head) === "action" && kinds.get(current) === "ai")
            return { code: "unsupported", message: `an AI step cannot be sent "$${head}", an Action's output`, hint: "an Action's output cannot be read again as the model's audience (ADR-0067): read what the model needs in a read step" };
          return undefined;
        }
        if (siblings.includes(head)) return { code: "unsupported", message: `"$${head}" runs at the same time as this read`, hint: "a parallel step's reads do not depend on each other: move the dependent read after it" };
        if (all.has(head)) return { code: "forward-reference", message: `"$${head}" is a later step, or this one`, hint: "a flow runs in order: refer to an earlier step" };
        if (["state", "params", "me", "row"].includes(head)) return { code: "unknown-reference", message: `"$${head}" belongs to the interface; a flow sees $input and earlier steps`, hint: "pass the value in the flow's input" };
        return undefined;
      },
      onFn: (call, args, fat) => this.fn(call, args, fat)
    });

    const covers = (when: Expr | undefined, skipped: readonly string[]) => skipped.every((s) => implies(when, conditions.get(s)));
    const requireKnown = (v: Typed, current: StepIR, vat: string, what: string) => {
      const skipped = (v.skippedBy ?? []).filter((s) => s !== current.name);
      if (skipped.length && !covers(current.when, skipped))
        this.d.error("maybe-skipped", vat, `${what} comes from ${skipped.map((s) => `"${s}"`).join(", ")}, which may be skipped, so it may be unknown here`, `give "${current.name}" the same when, or { "coalesce": [value, default] }`, "a required value that is unknown fails the step at run time");
    };

    for (const [i, s] of flow.steps.entries()) {
      const sat = `${at}/steps/${i}`;
      const scope = scopeFor(s.name);
      if (s.when !== undefined) {
        const w = checkExpr(s.when, scope, `${sat}/when`, this.d);
        if (w.ty.t !== "boolean" && w.ty.t !== "unknown") this.d.error("type-mismatch", `${sat}/when`, `when is a boolean, and this is ${describe(w.ty)}`);
        if (alwaysFalse(s.when)) this.d.warn("unreachable-step", `${sat}/when`, `step "${s.name}" never runs`, "remove it, or correct its condition");
      }
      const self = (ty: Ty, base: Partial<Typed> = {}): Typed => ({ ...base, ty, ...(s.when !== undefined || base.skippedBy?.length ? { skippedBy: [...new Set([...(base.skippedBy ?? []), ...(s.when !== undefined ? [s.name] : [])])] } : {}) });
      conditions.set(s.name, s.when);
      switch (s.kind) {
        case "read": {
          const r = this.read(s.read, scope, `${sat}/read`, true);
          r.types.forEach((t) => reads.add(t));
          outputs.set(s.name, self(r.typed.ty, { ...(s.onError === "continue" ? { skippedBy: [s.name] } : r.typed.skippedBy ? { skippedBy: r.typed.skippedBy } : {}) }));
          if (s.onError === "continue") conditions.set(s.name, undefined);
          break;
        }
        case "parallel": {
          const siblings = s.steps.map((r) => r.name);
          const results: [string, Typed, Expr | undefined][] = [];
          for (const [j, r] of s.steps.entries()) {
            const rat = `${sat}/steps/${j}`;
            const rscope = scopeFor(r.name, {}, siblings);
            if (r.when !== undefined) checkExpr(r.when, rscope, `${rat}/when`, this.d);
            const typed = this.read(r.read, rscope, `${rat}/read`, true);
            typed.types.forEach((t) => reads.add(t));
            const skipped = [...(r.when !== undefined || r.onError === "continue" ? [r.name] : []), ...(typed.typed.skippedBy ?? [])];
            results.push([r.name, { ty: typed.typed.ty, ...(skipped.length ? { skippedBy: skipped } : {}) }, r.onError === "continue" ? undefined : r.when]);
          }
          for (const [n, t, w] of results) {
            outputs.set(n, t);
            conditions.set(n, w);
          }
          outputs.set(s.name, { ty: { t: "object", fields: Object.fromEntries(results.map(([n, t]) => [n, { ty: t.ty, optional: (t.skippedBy?.length ?? 0) > 0 }])) } });
          break;
        }
        case "forEach": {
          const over = checkExpr(s.over, scope, `${sat}/over`, this.d);
          if (over.ty.t !== "list" && over.ty.t !== "unknown") this.d.error("list-expected", `${sat}/over`, `forEach goes over a list, and this is ${describe(over.ty)}`);
          const item: Typed = { ty: over.ty.t === "list" ? over.ty.of : UNKNOWN };
          const r = this.read(s.read, scopeFor(s.name, { item }), `${sat}/read`, true);
          r.types.forEach((t) => reads.add(t));
          if (s.read.kind === "aggregate") this.d.error("unsupported", `${sat}/read`, "forEach reads objects, queries or relationships; an aggregate already covers many objects", "aggregate once, grouped by the field you would iterate on");
          outputs.set(s.name, self({ t: "list", of: r.typed.ty }, over.skippedBy ? { skippedBy: over.skippedBy } : {}));
          break;
        }
        case "compute": {
          const v = checkExpr(s.value, scope, `${sat}/value`, this.d);
          outputs.set(s.name, self(v.ty, { ...(v.withheld ? { withheld: true } : {}), ...(v.skippedBy ? { skippedBy: v.skippedBy } : {}), ...(v.nullable ? { nullable: true } : {}) }));
          break;
        }
        case "check": {
          const v = checkExpr(s.assert, scope, `${sat}/assert`, this.d);
          if (v.ty.t !== "boolean" && v.ty.t !== "unknown") this.d.error("type-mismatch", `${sat}/assert`, `assert is a boolean, and this is ${describe(v.ty)}`);
          outputs.set(s.name, self(BOOLEAN));
          break;
        }
        case "ai": {
          const role = this.app.models?.[s.model];
          if (!role) this.d.error("unknown-model", `${sat}/model`, `no model role "${s.model}"`, Object.keys(this.app.models ?? {}).length ? `roles: ${Object.keys(this.app.models ?? {}).join(", ")}` : 'declare it: "models": { "' + s.model + '": { "id": "<model id in typesys.llm.json>" } }');
          if (!this.app.llm) this.d.error("unknown-model", "/llm", "the application has an AI step and no LLM configuration", 'set "llm": "typesys.llm.json"');
          if (role && this.env.models) {
            const m = this.env.models[role.id];
            if (!m) this.d.error("unknown-model", `/models/${s.model}/id`, `the LLM configuration has no model "${role.id}"`, `models: ${Object.keys(this.env.models).join(", ") || "none"}`);
            else if (!m.uses.includes("runtime")) this.d.error("model-not-runtime", `/models/${s.model}/id`, `model "${role.id}" is configured for ${m.uses.join(", ")}, not runtime`, "an AI step runs in the application: use a model whose uses include runtime", "a development model is never sent production data (ADR-0074)");
          }
          for (const [k, v] of Object.entries(s.input)) checkExpr(v, scope, `${sat}/input/${k}`, this.d);
          const out = schemaToTy(s.output);
          if (out.ty.t !== "object") this.d.error("type-mismatch", `${sat}/output`, "an AI step's output is an object schema", "name each part of the answer, so later steps and the approver can refer to it");
          outputs.set(s.name, self(out.ty));
          break;
        }
        case "approval": {
          for (const [j, p] of s.present.entries()) {
            if (!outputs.has(p)) this.d.error(all.has(p) ? "forward-reference" : "unknown-reference", `${sat}/present/${j}`, `the approval presents "${p}", which is not an earlier step`);
          }
          if (s.allowSelfApproval) this.d.warn("self-approval", `${sat}/allowSelfApproval`, `approval "${s.name}" lets the initiator approve their own run`, "remove allowSelfApproval unless the requirement says so");
          outputs.set(s.name, self(APPROVAL_OUTPUT));
          break;
        }
        case "action": {
          const a = this.action(s.action, `${sat}/action`);
          if (a) {
            this.inputs(a, s.input, scope, `${sat}/input`, (v, vat, field) => requireKnown(v, s, vat, `input "${field}"`));
            a.applicableTypes.forEach((t) => writes.add(t));
          }
          const outTy = a ? schemaToTy(a.outputSchema).ty : UNKNOWN;
          if (s.compensate) {
            const c = this.action(s.compensate.action, `${sat}/compensate/action`);
            const cscope = extend(scopeFor(s.name), { output: { ty: outTy } });
            if (c) {
              this.inputs(c, s.compensate.input, cscope, `${sat}/compensate/input`);
              c.applicableTypes.forEach((t) => writes.add(t));
            }
          } else if (a && a.idempotency === "none" && a.sideEffects !== "none" && i < flow.steps.length - 1)
            this.d.warn("uncompensated-action", `${sat}`, `Action ${a.name} is not idempotent, and nothing undoes it if a later step fails`, "declare compensate", "a failure after it leaves its effect in place");
          outputs.set(s.name, self(outTy));
          break;
        }
      }
    }

    // The engine's own check on the definition the compiler will generate (ADR-0057): the rules are its, applied here early.
    const lowered = lowerSteps(flow);
    const names = engineNames(flow);
    const indexOf = (engine: string) => flow.steps.findIndex((s) => s.name === engine);
    for (const w of validateWorkflow(skeleton(flow), this.env.model)) {
      if (w.code === "unknown-action" || w.code === "invalid-name" || w.code === "duplicate-step") continue; // reported above, with hints
      const i = w.step ? indexOf(names.get(w.step) ?? w.step) : -1;
      this.d.error(w.code, i >= 0 ? `${at}/steps/${i}` : at, w.message, WORKFLOW_HINTS[w.code], "the workflow engine refuses this definition when it is registered");
    }
    return { key, flow, lowered, outputs, input, reads: [...reads].sort(), writes: [...writes].sort() };
  }

  /** An Action's input given as expressions: each one it takes, each one it needs, each of its type. */
  private inputs(a: ActionDescription, input: Readonly<Record<string, Expr>>, scope: Scope, at: string, onValue?: (v: Typed, at: string, field: string) => void): void {
    const props = (a.inputSchema.properties ?? {});
    const required = Array.isArray(a.inputSchema.required) ? a.inputSchema.required : [];
    for (const [k, e] of Object.entries(input)) {
      const kat = `${at}/${k}`;
      const v = checkExpr(e, scope, kat, this.d);
      if (!Object.hasOwn(props, k)) {
        const near = didYouMean(k, Object.keys(props));
        this.d.error("unknown-input", kat, `Action ${a.name} takes no input "${k}"`, near ? `did you mean "${near}"?` : `it takes ${Object.keys(props).join(", ")}`);
        continue;
      }
      const want = schemaToTy(props[k]);
      const why = assignable(v.ty, want.ty);
      if (why) this.d.error(why.includes("not one of") ? "not-in-enum" : "type-mismatch", kat, `${a.name}.${k} expects ${describe(want.ty)}: ${why}`, "nothing is converted: give a value of the input's type");
      if (required.includes(k)) onValue?.(v, kat, k);
    }
    for (const r of required) if (!Object.hasOwn(input, r)) this.d.error("missing-input", at, `Action ${a.name} needs input "${r}"`, `add "${r}"`);
  }

  /** Who each flow's policies admit, and what each AI step's model may be told of (ADR-0067). */
  private async governFlows(): Promise<void> {
    const callers = Object.keys(this.app.callers);
    for (const [key, info] of this.flows) {
      const flow = info.flow;
      const at = pointer("flows", key);
      let start: string[] | undefined;
      const approvals: Record<string, string[]> = {};
      if (this.env.admits) {
        start = [];
        for (const c of callers) if (await this.env.admits(flow.startPolicy, { typeName: flow.name, actionName: "start" }, c)) start.push(c);
        if (start.length === 0) this.d.warn("no-caller-admitted", `${at}/startPolicy`, `policy "${flow.startPolicy}" admits none of ${callers.join(", ")} to start ${flow.name}`, "check the policy's name and the callers' roles");
        for (const [i, s] of flow.steps.entries()) {
          if (s.kind !== "approval") continue;
          const admitted: string[] = [];
          for (const c of callers) if (await this.env.admits(s.policy, { typeName: flow.name, actionName: s.name }, c)) admitted.push(c);
          approvals[s.name] = admitted;
          if (admitted.length === 0) this.d.warn("no-caller-admitted", `${at}/steps/${i}/policy`, `policy "${s.policy}" admits none of ${callers.join(", ")} to approve "${s.name}"`, "check the policy's name and the callers' roles", "a run waiting on it waits until its deadline");
        }
        (this.flows).set(key, { ...info, admitted: { start, approvals } });
      }
      // Each AI step's model, told of each Type the step's inputs come from, as each caller who may start the run.
      if (!this.env.describedToAudience || !this.env.models) continue;
      for (const [i, s] of flow.steps.entries()) {
        if (s.kind !== "ai") continue;
        const role = this.app.models?.[s.model];
        const model = role ? this.env.models[role.id] : undefined;
        if (!model) continue;
        const audience = model.audience ?? { id: `model:${role!.id}`, kind: "model" as const, roles: [], attributes: {} };
        const upstream = upstreamReads(flow, s.name);
        for (const c of start ?? callers) {
          const told = await this.env.describedToAudience(c, audience);
          const blind = upstream.filter((t) => !told?.types.some((x) => x.name === t));
          if (blind.length)
            this.d.add("model-audience-blind", `${at}/steps/${i}`, `model "${role!.id}" (audience ${audience.id}) is not told of ${blind.join(", ")} when ${c} runs ${flow.name}`, {
              severity: s.release === "redact" ? "info" : "warning",
              hint: s.release === "redact" ? "the model will be sent what it may receive" : "grant the audience those Types, or set release: redact if the model may work from a partial view",
              because: "the engine releases an AI step's input only as the model's audience may read it (ADR-0067)"
            });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Interface
  // -------------------------------------------------------------------------

  private node(n: NodeIR, at: string, scope: Scope, data: Readonly<Record<string, DataInfo>>, state: Readonly<Record<string, StateIR>>, pages: ReadonlySet<string>): void {
    if (n.when !== undefined) {
      const w = checkExpr(n.when, scope, `${at}/when`, this.d);
      if (w.ty.t !== "boolean" && w.ty.t !== "unknown") this.d.error("type-mismatch", `${at}/when`, `when is a boolean, and this is ${describe(w.ty)}`);
    }
    const kids = (children: readonly NodeIR[], key: string) => children.forEach((c, i) => this.node(c, `${at}/${key}/${i}`, scope, data, state, pages));
    const listOf = (name: string, pat: string): Ty | undefined => {
      const info = this.dataRef(name, data, pat);
      if (!info) return undefined;
      if (info.typed.ty.t !== "list" && info.typed.ty.t !== "unknown") {
        this.d.error("list-expected", pat, `"${name}" is ${describe(info.typed.ty)}; a ${n.kind} shows a list`, "use a query, related read, aggregate or a derived list");
        return undefined;
      }
      return info.typed.ty.t === "list" ? info.typed.ty.of : UNKNOWN;
    };
    const objectOf = (name: string, pat: string): Ty | undefined => {
      const info = this.dataRef(name, data, pat);
      if (!info) return undefined;
      if (info.typed.ty.t !== "object" && info.typed.ty.t !== "unknown") {
        this.d.error("type-mismatch", pat, `"${name}" is ${describe(info.typed.ty)}; a ${n.kind} shows one object`, "use an object read");
        return undefined;
      }
      return info.typed.ty;
    };
    const field = (elem: Ty | undefined, f: string, fat: string): Typed | undefined => {
      if (!elem) return undefined;
      const d0 = this.d.errors;
      const v = walk({ ty: elem }, f.split("."), "each element", fat, this.d);
      return this.d.errors > d0 ? undefined : v;
    };
    const itemScope = (elem: Ty | undefined) => extend(scope, { item: { ty: elem ?? UNKNOWN } });
    const tone = (e: Expr | undefined, s: Scope, tat: string) => {
      if (e === undefined) return;
      const v = checkExpr(e, s, tat, this.d);
      if (v.ty.t === "string" && v.ty.enum) {
        const bad = v.ty.enum.filter((x) => !TONE_VALUES.includes(x));
        if (bad.length) this.d.error("not-in-enum", tat, `${bad.map((b) => JSON.stringify(b)).join(", ")} is not a tone`, `tones: ${TONE_VALUES.join(", ")}`);
      } else if (v.ty.t !== "string" && v.ty.t !== "unknown") this.d.error("type-mismatch", tat, `a tone is one of ${TONE_VALUES.join(", ")}, and this is ${describe(v.ty)}`);
    };
    const stateRef = (name: string, sat: string, want: Ty) => {
      const s = state[name];
      if (!s) {
        const near = didYouMean(name, Object.keys(state));
        return this.d.error("unknown-reference", sat, `no state "${name}"`, near ? `did you mean "${near}"?` : 'declare it: "state": { "' + name + '": { "schema": { "type": ["string", "null"] }, "default": null } }');
      }
      const why = assignable(want, schemaToTy(s.schema).ty);
      if (why) this.d.error("type-mismatch", sat, `state "${name}" cannot hold ${describe(want)}: ${why}`);
    };
    const columns = (cols: readonly FieldRefIR[], elem: Ty | undefined, cat: string) => {
      for (const [i, c] of cols.entries()) {
        const name = typeof c === "string" ? c : c.field;
        const fat = typeof c === "string" ? `${cat}/${i}` : `${cat}/${i}/field`;
        const v = field(elem, name, fat);
        if (v && typeof c !== "string" && c.tone) {
          for (const [value, t] of Object.entries(c.tone)) {
            if (!TONE_VALUES.includes(t)) this.d.error("not-in-enum", `${cat}/${i}/tone/${value}`, `"${t}" is not a tone`, `tones: ${TONE_VALUES.join(", ")}`);
            if (v.ty.t === "string" && v.ty.enum && !v.ty.enum.includes(value)) this.d.error("not-in-enum", `${cat}/${i}/tone/${value}`, `"${value}" is never a value of ${name}`, `its values: ${v.ty.enum.join(", ")}`);
          }
        }
      }
    };
    switch (n.kind) {
      case "grid":
        if (n.columns !== undefined && !(Number.isInteger(n.columns) && n.columns >= 1 && n.columns <= 12)) this.d.error("invalid-app", `${at}/columns`, "columns is 1 to 12");
        return kids(n.children, "children");
      case "stack":
      case "section":
        return kids(n.children, "children");
      case "tabs":
        return n.tabs.forEach((t, i) => this.node(t.content, `${at}/tabs/${i}/content`, scope, data, state, pages));
      case "text": {
        const v = checkExpr(n.text, scope, `${at}/text`, this.d);
        if (!["string", "number", "unknown"].includes(v.ty.t)) this.d.error("type-mismatch", `${at}/text`, `text is a string, and this is ${describe(v.ty)}`, "use concat to build one");
        return;
      }
      case "metric": {
        const v = checkExpr(n.value, scope, `${at}/value`, this.d);
        if (!["number", "string", "unknown"].includes(v.ty.t)) this.d.error("type-mismatch", `${at}/value`, `a metric shows a number or a string, and this is ${describe(v.ty)}`, "use count, sum or another aggregate");
        tone(n.tone, scope, `${at}/tone`);
        if (n.caption !== undefined) checkExpr(n.caption, scope, `${at}/caption`, this.d);
        return;
      }
      case "chart": {
        const elem = listOf(n.data, `${at}/data`);
        field(elem, n.x, `${at}/x`);
        n.y.forEach((y, i) => {
          const v = field(elem, y, `${at}/y/${i}`);
          if (v && v.ty.t !== "number" && v.ty.t !== "unknown") this.d.error("type-mismatch", `${at}/y/${i}`, `a chart plots numbers, and ${y} is ${describe(v.ty)}`);
        });
        if (n.band) {
          for (const k of ["from", "to"] as const) {
            const v = checkExpr(n.band[k], scope, `${at}/band/${k}`, this.d);
            if (v.ty.t !== "number" && v.ty.t !== "unknown") this.d.error("type-mismatch", `${at}/band/${k}`, `a band's ${k} is a number`);
          }
        }
        return;
      }
      case "table": {
        const elem = listOf(n.data, `${at}/data`);
        columns(n.columns, elem, `${at}/columns`);
        if (n.groupBy) field(elem, n.groupBy, `${at}/groupBy`);
        n.filters?.forEach((f, i) => field(elem, f, `${at}/filters/${i}`));
        if (n.select) stateRef(n.select, `${at}/select`, STRING);
        const rowScope = extend(scope, { row: { ty: elem ?? UNKNOWN } });
        if (n.onSelect) this.effects(n.onSelect, `${at}/onSelect`, rowScope, data, state, pages);
        n.rowActions?.forEach((ra, i) => {
          if (ra.when !== undefined) checkExpr(ra.when, rowScope, `${at}/rowActions/${i}/when`, this.d);
          this.effects(ra.do, `${at}/rowActions/${i}/do`, rowScope, data, state, pages);
        });
        if (n.pageSize !== undefined && !(Number.isInteger(n.pageSize) && n.pageSize >= 5 && n.pageSize <= 200)) this.d.error("invalid-app", `${at}/pageSize`, "pageSize is 5 to 200");
        return;
      }
      case "detail": {
        const obj = objectOf(n.data, `${at}/data`);
        columns(n.fields, obj, `${at}/fields`);
        if (n.headline) field(obj, n.headline, `${at}/headline`);
        return;
      }
      case "timeline": {
        const elem = listOf(n.data, `${at}/data`);
        const t = field(elem, n.time, `${at}/time`);
        if (t && !(t.ty.t === "string" && (t.ty.format === "date-time" || t.ty.format === "date")) && t.ty.t !== "unknown") this.d.error("type-mismatch", `${at}/time`, `a timeline orders by a date-time, and ${n.time} is ${describe(t.ty)}`);
        const s = itemScope(elem);
        checkExpr(n.label, s, `${at}/label`, this.d);
        if (n.detail !== undefined) checkExpr(n.detail, s, `${at}/detail`, this.d);
        tone(n.tone, s, `${at}/tone`);
        return;
      }
      case "graph": {
        const obj = objectOf(n.root, `${at}/root`);
        const rootType = obj?.t === "object" ? obj.semantic : undefined;
        for (const [i, rel] of n.relationships.entries()) {
          const [tn, rn] = rel.includes(".") && /^[a-z].*\.[A-Z][^.]*\./.test(rel) ? [rel.slice(0, rel.lastIndexOf(".")), rel.slice(rel.lastIndexOf(".") + 1)] : [rootType, rel];
          if (!tn) continue;
          const t = this.type(tn, `${at}/relationships/${i}`);
          if (t && !t.relationships.some((r) => r.name === rn)) {
            const near = didYouMean(rn, t.relationships.map((r) => r.name));
            this.d.error("unknown-relationship", `${at}/relationships/${i}`, `${t.name} has no relationship "${rn}"`, near ? `did you mean "${near}"?` : undefined);
          }
        }
        for (const [tn, f] of Object.entries(n.label ?? {})) {
          const t = this.type(tn, `${at}/label/${tn}`);
          if (t) this.member(t, f, `${at}/label/${tn}`);
        }
        return;
      }
      case "map": {
        const elem = listOf(n.data, `${at}/data`);
        for (const k of ["lat", "lon"] as const) {
          const v = field(elem, n[k], `${at}/${k}`);
          if (v && v.ty.t !== "number" && v.ty.t !== "unknown") this.d.error("type-mismatch", `${at}/${k}`, `${k} is a number, and ${n[k]} is ${describe(v.ty)}`);
        }
        const s = itemScope(elem);
        checkExpr(n.label, s, `${at}/label`, this.d);
        tone(n.tone, s, `${at}/tone`);
        if (n.select) stateRef(n.select, `${at}/select`, STRING);
        return;
      }
      case "form": {
        if (n.action) {
          const a = this.action(n.action, `${at}/action`);
          if (a) this.formFields(n, schemaFields(a.inputSchema), `Action ${a.name}`, scope, at);
        } else if (n.flow) {
          const f = this.flowRef(n.flow, `${at}/flow`);
          if (f) this.formFields(n, Object.fromEntries(Object.entries(f.flow.input).map(([k, v]) => [k, { schema: v.schema, required: true }])), `flow ${n.flow}`, scope, at);
          if (n.into) stateRef(n.into, `${at}/into`, RUN_ID);
        }
        if (n.then) this.effects(n.then, `${at}/then`, extend(scope, { result: { ty: UNKNOWN } }), data, state, pages);
        return;
      }
      case "approvals":
        n.flows?.forEach((f, i) => this.flowRef(f, `${at}/flows/${i}`));
        return;
      case "run": {
        const v = checkExpr(n.run, scope, `${at}/run`, this.d);
        if (v.ty.t !== "string" && v.ty.t !== "unknown") this.d.error("type-mismatch", `${at}/run`, "a run is shown by its id, a string");
        this.flowRef(n.flow, `${at}/flow`);
        return;
      }
      case "assistant": {
        const f = this.flowRef(n.flow, `${at}/flow`);
        if (!f) return;
        this.flowInput(f, n.input, scope, `${at}/input`);
        const step = f.flow.steps.find((s) => s.name === n.step);
        if (!step || step.kind !== "ai") this.d.error("unknown-reference", `${at}/step`, `flow ${n.flow} has no AI step "${n.step}"`, `its AI steps: ${f.flow.steps.filter((s) => s.kind === "ai").map((s) => s.name).join(", ") || "none"}`);
        const acting = f.flow.steps.filter((s) => s.kind === "action" || s.kind === "approval");
        if (acting.length)
          this.d.error("unsupported", `${at}/flow`, `an assistant runs flow ${n.flow} on request, and it has ${acting.map((s) => `${s.kind} "${s.name}"`).join(", ")}`, "give the assistant a flow of reads and the AI step only; start the acting flow with a form or a run effect", "an assistant explains; what changes a system is started deliberately, and approved");
        if (n.into) stateRef(n.into, `${at}/into`, RUN_ID);
        return;
      }
      case "provenance": {
        const obj = objectOf(n.data, `${at}/data`);
        if (obj?.t === "object" && obj.semantic) this.member(this.types.get(obj.semantic)!, n.property, `${at}/property`);
        return;
      }
      case "actions":
        n.buttons.forEach((b, i) => {
          if (b.when !== undefined) checkExpr(b.when, scope, `${at}/buttons/${i}/when`, this.d);
          this.effects(b.do, `${at}/buttons/${i}/do`, scope, data, state, pages);
        });
        return;
      case "custom": {
        const m = /^([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)#([A-Z][A-Za-z0-9]*)$/.exec(n.component);
        if (!m) return this.d.error("invalid-app", `${at}/component`, `"${n.component}" is not <module>#<Component>`, 'e.g. "stability#StabilityBudget", src/extensions/stability.tsx');
        const props: Record<string, Ty> = {};
        for (const [k, schema] of Object.entries(n.propTypes)) {
          if (!/^[a-z][A-Za-z0-9]*$/.test(k)) this.d.error("invalid-name", `${at}/propTypes/${k}`, `prop "${k}" is not a camelCase name`);
          props[k] = schemaToTy(schema).ty;
        }
        for (const [k, e] of Object.entries(n.props)) {
          const v = checkExpr(e, scope, `${at}/props/${k}`, this.d);
          if (!Object.hasOwn(props, k)) {
            this.d.error("unknown-input", `${at}/props/${k}`, `prop "${k}" has no type in propTypes`, "declare it in propTypes: the contract the component is checked against");
            continue;
          }
          const why = assignable(v.ty, props[k]!);
          if (why) this.d.error("type-mismatch", `${at}/props/${k}`, `prop "${k}" expects ${describe(props[k]!)}: ${why}`);
        }
        for (const k of Object.keys(props)) if (!Object.hasOwn(n.props, k)) this.d.error("missing-input", `${at}/props`, `prop "${k}" is typed and not given`);
        const prior = this.components.get(n.component);
        if (prior && canonical(prior.props) !== canonical(props)) this.d.error("type-mismatch", `${at}/propTypes`, `${n.component} is used with different propTypes elsewhere`, "one component has one contract");
        this.components.set(n.component, { component: n.component, module: m[1]!, export: m[2]!, props });
        if (this.env.extensionExists && !this.env.extensionExists(m[1]!)) this.d.info("extension-missing", `${at}/component`, `src/extensions/${m[1]}.tsx does not exist yet`, "compile writes a typed stub there once; then make it yours");
        return;
      }
    }
  }

  private formFields(n: Extract<NodeIR, { kind: "form" }>, inputs: Record<string, { schema: JsonSchema2020; required: boolean }>, what: string, scope: Scope, at: string): void {
    for (const [k, e] of Object.entries(n.defaults ?? {})) {
      const v = checkExpr(e, scope, `${at}/defaults/${k}`, this.d);
      const input = inputs[k];
      if (!input) {
        const near = didYouMean(k, Object.keys(inputs));
        this.d.error("unknown-input", `${at}/defaults/${k}`, `${what} takes no input "${k}"`, near ? `did you mean "${near}"?` : `it takes ${Object.keys(inputs).join(", ")}`);
        continue;
      }
      const why = assignable(v.ty, schemaToTy(input.schema).ty);
      if (why) this.d.error("type-mismatch", `${at}/defaults/${k}`, `${what} input "${k}" expects ${describe(schemaToTy(input.schema).ty)}: ${why}`);
    }
    for (const [i, f] of (n.fields ?? []).entries()) if (!inputs[f]) this.d.error("unknown-input", `${at}/fields/${i}`, `${what} takes no input "${f}"`, `it takes ${Object.keys(inputs).join(", ")}`);
    const shown = new Set(n.fields ?? Object.keys(inputs).filter((k) => !Object.hasOwn(n.defaults ?? {}, k)));
    for (const [k, input] of Object.entries(inputs)) if (input.required && !shown.has(k) && !Object.hasOwn(n.defaults ?? {}, k)) this.d.error("missing-input", `${at}/fields`, `${what} needs "${k}", and the form neither shows nor defaults it`);
  }

  private flowRef(key: string, at: string): FlowInfo | undefined {
    const f = this.flows.get(key);
    if (!f) {
      const near = didYouMean(key, this.flows.keys());
      this.d.error("unknown-flow", at, `no flow "${key}"`, near ? `did you mean "${near}"?` : `flows: ${[...this.flows.keys()].join(", ") || "none"}`);
    }
    return f;
  }

  private flowInput(f: FlowInfo, input: Readonly<Record<string, Expr>>, scope: Scope, at: string): void {
    for (const [k, e] of Object.entries(input)) {
      const v = checkExpr(e, scope, `${at}/${k}`, this.d);
      const want = f.input.fields[k];
      if (!want) {
        const near = didYouMean(k, Object.keys(f.input.fields));
        this.d.error("unknown-input", `${at}/${k}`, `flow ${f.key} takes no input "${k}"`, near ? `did you mean "${near}"?` : `it takes ${Object.keys(f.input.fields).join(", ") || "nothing"}`);
        continue;
      }
      const why = assignable(v.ty, want.ty);
      if (why) this.d.error("type-mismatch", `${at}/${k}`, `flow ${f.key} input "${k}" expects ${describe(want.ty)}: ${why}`);
    }
    for (const k of Object.keys(f.input.fields)) if (!Object.hasOwn(input, k)) this.d.error("missing-input", at, `flow ${f.key} needs input "${k}"`);
  }

  private dataRef(name: string, data: Readonly<Record<string, DataInfo>>, at: string): DataInfo | undefined {
    const info = data[name];
    if (!info) {
      const near = didYouMean(name, Object.keys(data));
      this.d.error("unknown-reference", at, `no data "${name}"`, near ? `did you mean "${near}"?` : `data: ${Object.keys(data).join(", ") || "none"}`);
    }
    return info;
  }

  private effects(list: readonly EffectIR[], at: string, scope: Scope, data: Readonly<Record<string, DataInfo>>, state: Readonly<Record<string, StateIR>>, pages: ReadonlySet<string>): void {
    for (const [i, e] of list.entries()) {
      const eat = `${at}/${i}`;
      if ("set" in e) {
        const v = checkExpr(e.value, scope, `${eat}/value`, this.d);
        const s = state[e.set];
        if (!s) {
          const near = didYouMean(e.set, Object.keys(state));
          this.d.error("unknown-reference", `${eat}/set`, `no state "${e.set}"`, near ? `did you mean "${near}"?` : undefined);
        } else {
          const why = assignable(v.ty, schemaToTy(s.schema).ty);
          if (why) this.d.error("type-mismatch", `${eat}/value`, `state "${e.set}" cannot hold ${describe(v.ty)}: ${why}`);
        }
      } else if ("run" in e) {
        const f = this.flowRef(e.run, `${eat}/run`);
        if (f) this.flowInput(f, e.input, scope, `${eat}/input`);
        if (e.into && !state[e.into]) this.d.error("unknown-reference", `${eat}/into`, `no state "${e.into}"`);
      } else if ("invoke" in e) {
        const a = this.action(e.invoke, `${eat}/invoke`);
        if (a) {
          this.inputs(a, e.input, scope, `${eat}/input`);
          if (e.confirm === false && a.sideEffects !== "none")
            this.d.error("unconfirmed-effect", `${eat}/confirm`, `${a.name} changes ${a.sideEffects === "external" ? "an external system" : "data"} (${a.sideEffects}), and confirm is false`, "remove confirm: false", "a person is shown the runtime's preview of an Action that changes a system, and confirms it");
        }
      } else if ("navigate" in e) {
        if (!pages.has(e.navigate)) {
          const near = didYouMean(e.navigate, pages);
          this.d.error("unknown-page", `${eat}/navigate`, `no page "${e.navigate}"`, near ? `did you mean "${near}"?` : undefined);
          continue;
        }
        const target = this.app.pages.find((p) => p.name === e.navigate)!;
        const params = target.params ?? {};
        for (const [k, v] of Object.entries(e.params ?? {})) {
          const t = checkExpr(v, scope, `${eat}/params/${k}`, this.d);
          if (!params[k]) this.d.error("unknown-input", `${eat}/params/${k}`, `page ${e.navigate} has no param "${k}"`);
          else if (t.ty.t !== "string" && t.ty.t !== "number" && t.ty.t !== "unknown") this.d.error("type-mismatch", `${eat}/params/${k}`, "a page param is a string");
        }
        for (const k of Object.keys(params)) if (!Object.hasOwn(e.params ?? {}, k)) this.d.error("missing-input", `${eat}/params`, `page ${e.navigate} needs param "${k}"`);
      } else if ("refresh" in e) {
        for (const [j, r] of e.refresh.entries()) if (!data[r]) this.d.error("unknown-reference", `${eat}/refresh/${j}`, `no data "${r}"`);
      }
    }
  }

  private fn(call: FnCall, args: Readonly<Record<string, Typed>>, at: string): void {
    const m = /^([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)#([A-Za-z_][A-Za-z0-9_]*)$/.exec(call.fn);
    if (!m) return;
    const returns = schemaToTy(call.returns).ty;
    const prior = this.fns.get(call.fn);
    const shape = (a: Readonly<Record<string, Typed>>) => canonical(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.ty])));
    if (prior && (shape(prior.args) !== shape(args) || canonical(prior.returns) !== canonical(returns)))
      this.d.error("type-mismatch", at, `${call.fn} is called with other argument or return types elsewhere`, "one function has one contract: give every call the same argument and return types");
    if (!prior) this.fns.set(call.fn, { fn: call.fn, module: m[1]!, export: m[2]!, args, returns });
    if (this.env.extensionExists && !this.env.extensionExists(m[1]!)) this.d.info("extension-missing", at, `src/extensions/${m[1]}.ts does not exist yet`, "compile writes a typed stub there once; then make it yours");
  }

  // -------------------------------------------------------------------------
  // Acceptance
  // -------------------------------------------------------------------------

  private acceptance(pages: ReadonlySet<string>): void {
    const callers = Object.keys(this.app.callers);
    const nodeIds = new Map<string, NodeIR>();
    const collect = (n: NodeIR) => {
      if (n.id) nodeIds.set(n.id, n);
      if ("children" in n) n.children.forEach(collect);
      if (n.kind === "tabs") n.tabs.forEach((t) => collect(t.content));
    };
    this.app.pages.forEach((p) => collect(p.layout));
    const flowNames = new Map([...this.flows.values()].map((f) => [f.flow.name, f]));
    for (const [i, c] of this.app.acceptance.entries()) {
      const at = pointer("acceptance", i);
      for (const [k, who] of [["as", c.as], ...(c.kind === "approves" ? [["startedBy", c.startedBy]] : [])] as [string, string][])
        if (!callers.includes(who)) this.d.error("invalid-check", `${at}/${k}`, `"${who}" is not one of the application's callers`, `callers: ${callers.join(", ")}`);
      if (c.kind === "screen") {
        if (!pages.has(c.page)) this.d.error("unknown-page", `${at}/page`, `no page "${c.page}"`);
        const page = this.app.pages.find((p) => p.name === c.page);
        for (const k of Object.keys(page?.params ?? {})) if (!Object.hasOwn(c.params ?? {}, k)) this.d.error("invalid-check", `${at}/params`, `page ${c.page} needs param "${k}"`);
        for (const key of ["visible", "hidden"] as const) (c[key] ?? []).forEach((id, j) => !nodeIds.has(id) && this.d.error("invalid-check", `${at}/${key}/${j}`, `no node with id "${id}"`, "give the node an id"));
        for (const [id, r] of Object.entries(c.rows ?? {})) {
          const n = nodeIds.get(id);
          if (!n || n.kind !== "table") this.d.error("invalid-check", `${at}/rows/${id}`, `"${id}" is not the id of a table`);
          if (r.atLeast === undefined && r.atMost === undefined) this.d.error("invalid-check", `${at}/rows/${id}`, "a rows check sets atLeast, atMost or both");
        }
        continue;
      }
      if (c.kind === "starts" || c.kind === "approves") {
        const f = flowNames.get(c.workflow);
        if (!f) {
          this.d.error("unknown-flow", `${at}/workflow`, `no flow named ${c.workflow}`, `flows: ${[...flowNames.keys()].join(", ") || "none"}`);
          continue;
        }
        for (const k of Object.keys(c.input)) if (!Object.hasOwn(f.flow.input, k)) this.d.error("unknown-input", `${at}/input/${k}`, `${c.workflow} takes no input "${k}"`);
        for (const k of Object.keys(f.flow.input)) if (!Object.hasOwn(c.input, k)) this.d.error("missing-input", `${at}/input`, `${c.workflow} needs input "${k}"`);
        const steps: readonly { readonly name: string }[] = f.flow.steps.flatMap((s): { name: string }[] => (s.kind === "parallel" ? [s, ...s.steps] : [s]));
        if (c.kind === "starts" && c.failsAt !== undefined && !steps.some((s) => s.name === c.failsAt)) this.d.error("invalid-check", `${at}/failsAt`, `"${c.failsAt}" is not a step of ${c.workflow}`);
        if (c.kind === "starts" && c.failsAt !== undefined && c.status !== "failed") this.d.error("invalid-check", `${at}/failsAt`, 'failsAt applies only to a check whose status is "failed"');
        if (c.kind === "approves" && !f.flow.steps.some((s) => s.kind === "approval" && s.name === c.step)) this.d.error("invalid-check", `${at}/step`, `"${c.step}" is not an approval step of ${c.workflow}`);
        continue;
      }
      if (c.kind === "query") {
        if (c.atLeast === undefined && c.atMost === undefined) this.d.error("invalid-check", at, "a query check sets atLeast, atMost, or both");
        for (const x of validateQuery(this.env.model, c.query)) this.d.add(x.code === "unknown-type" ? "unknown-type" : "query", `${at}/query${x.path}`, x.message, { severity: x.severity });
        continue;
      }
      const t = this.type(c.type, `${at}/type`);
      if (c.kind === "reads") {
        if (!c.sees?.length && !c.withheld?.length) this.d.error("invalid-check", at, "a reads check names fields the caller sees, or withheld, or both");
        if (t) for (const [j, f] of [...(c.sees ?? []), ...(c.withheld ?? [])].entries()) this.member(t, f, `${at}/${j < (c.sees?.length ?? 0) ? "sees" : "withheld"}`);
      }
      if (c.kind === "offered") this.action(c.action, `${at}/action`);
    }
    const covered = new Set(this.app.acceptance.flatMap((c) => [c.as, ...(c.kind === "approves" ? [c.startedBy] : [])]));
    for (const c of callers) if (!covered.has(c)) this.d.warn("invalid-check", pointer("callers", c), `no check runs as ${c}`, "add a check for what this caller may and may not see or do");
  }
}

const WORKFLOW_HINTS: Readonly<Record<string, string>> = {
  "unreviewed-ai-output": "add an approval step that presents the AI step, before the Action",
  "retry-not-idempotent": "remove the retry, or make the Action idempotent in the model",
  "unreleasable-ai-input": "read what the model needs in a read step",
  "unknown-need": "refer to an earlier step",
  "invalid-deadline": "give a positive number of milliseconds",
  "missing-policy": "name the policy"
};

const isOperation = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v) && !isLiteral(v);

/** Whether `when` implies `given`: equal, or a conjunction that includes it. Undefined `given` is always implied. */
function implies(when: Expr | undefined, given: Expr | undefined): boolean {
  if (given === undefined) return true;
  if (when === undefined) return false;
  const g = canonical(given);
  if (canonical(when) === g) return true;
  const parts = typeof when === "object" && when !== null && "and" in when && Array.isArray((when as { and: unknown }).and) ? ((when as { and: unknown[] }).and) : [];
  return parts.some((p) => implies(p as Expr, given));
}

/** The Types an AI step's inputs come from: every read upstream of it. */
function upstreamReads(flow: FlowIR, name: string): string[] {
  const lowered = lowerSteps(flow);
  const byName = new Map(lowered.map((l) => [l.engineName, l]));
  const seen = new Set<string>();
  const stack = [...(byName.get(name)?.needs ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(byName.get(n)?.needs ?? []));
  }
  const types = new Set<string>();
  const readType = (r: ReadIR) => (r.kind === "query" ? r.query.type : r.kind === "aggregate" ? r.aggregate.type : r.type);
  for (const s of flow.steps) {
    if (!seen.has(s.name)) continue;
    if (s.kind === "read" || s.kind === "forEach") types.add(readType(s.read));
    if (s.kind === "parallel") s.steps.forEach((r) => types.add(readType(r.read)));
  }
  return [...types];
}

function stateField(s: StateIR): Field {
  const { ty, nullable } = schemaToTy(s.schema);
  return { ty, optional: nullable || s.default === undefined || s.default === null };
}

function schemaFields(schema: JsonSchema2020): Record<string, { schema: JsonSchema2020; required: boolean }> {
  const props = (typeof schema === "object" ? (schema.properties ?? {}) : {});
  const required = new Set(typeof schema === "object" && Array.isArray(schema.required) ? schema.required : []);
  return Object.fromEntries(Object.entries(props).map(([k, s]) => [k, { schema: s, required: required.has(k) }]));
}

/** A value a property's schema admits, standing in for an expression when the runtime's query check runs. */
function sampleOf(schema: JsonSchema2020 | undefined): unknown {
  if (!schema || typeof schema === "boolean") return "x";
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== "null") : schema.type;
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return true;
  if (t === "array") return [sampleOf(schema.items)];
  if (t === "string" && schema.format === "date-time") return "2026-01-01T00:00:00Z";
  if (t === "string" && schema.format === "date") return "2026-01-01";
  return "x";
}

export { isFnCall, mayBeUnknown, INTEGER, NUMBER };
