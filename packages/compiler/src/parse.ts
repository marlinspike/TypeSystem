import { didYouMean } from "@typesys/devkit";
import { NODE_BASE, NODE_CATALOG, STEP_BASE, STEP_CATALOG, type PropSpec } from "./catalog.js";
import { Diagnostics, pointer, type AppDiagnostic } from "./diagnostics.js";
import { APP_FORMAT, type AppSpec, type DataIR, type EffectIR, type NodeIR, type ReadIR, type StepIR } from "./ir.js";

export const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const CAMEL = /^[a-z][A-Za-z0-9]*$/;
export const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
export const QUALIFIED = /^[a-z][a-z0-9-]*\.[A-Z][A-Za-z0-9]*$/;
export const NODE_ID = /^[a-z][A-Za-z0-9-]*$/;

/** Names a reference scope already takes; nothing the application declares may shadow one. */
export const RESERVED = new Set(["input", "state", "params", "me", "row", "item", "output", "result", "literal", "fn"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const whole = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/**
 * Every structural problem with an application document, before anything is
 * looked up in a model (ADR-0080): shape, names, kinds, duplicates, unknown
 * fields. Empty means `checkApp` can read it.
 */
export function appProblems(doc: unknown): AppDiagnostic[] {
  const d = new Diagnostics();
  const bad = (at: string, message: string, hint?: string) => d.error("invalid-app", at, message, hint);
  if (!isObj(doc)) {
    bad("", "an application is a JSON object");
    return d.list;
  }
  const a = doc as Partial<AppSpec> & Record<string, unknown>;
  known(a, ["format", "name", "title", "requirement", "host", "callers", "llm", "models", "design", "state", "data", "flows", "pages", "acceptance"], "", d);
  if (a.format !== APP_FORMAT) bad("/format", `format is not ${APP_FORMAT}`, a.format === "typesys.mission/1" ? "translate a mission with `typesys app migrate`" : undefined);
  if (typeof a.name !== "string" || !NAME.test(a.name)) d.error("invalid-name", "/name", "name must be lower case words joined by -", 'e.g. "cold-chain-command"');
  if (!isStr(a.title)) bad("/title", "title is missing");
  if (!isStr(a.requirement)) bad("/requirement", "requirement is missing", "the person's words, unchanged");
  if (!isObj(a.host)) bad("/host", "host is missing", "{ module, build, identities }: the module that builds the governed runtime");
  else for (const k of ["module", "build", "identities"] as const) if (!isStr(a.host[k])) bad(`/host/${k}`, `host.${k} is missing`);
  if (!isObj(a.callers) || Object.keys(a.callers).length === 0) bad("/callers", "an application names at least one caller", "one per kind of person, with the token each signs in with; include someone not signed in");
  else for (const [n, c] of Object.entries(a.callers)) if (!isObj(c) || typeof c.token !== "string") bad(pointer("callers", n), "a caller needs the token it signs in with");
  if (a.llm !== undefined && !isStr(a.llm)) bad("/llm", "llm is the path of the LLM configuration");
  if (a.models !== undefined) {
    if (!isObj(a.models)) bad("/models", "models maps a role to { id }");
    else for (const [role, m] of Object.entries(a.models)) {
      if (!CAMEL.test(role)) d.error("invalid-name", pointer("models", role), "a model role is a camelCase word");
      if (!isObj(m) || !isStr(m.id)) bad(pointer("models", role), "a model role names the model's id in the LLM configuration");
    }
  }
  if (a.design !== undefined) design(a.design, d);

  states(a.state, "/state", d);
  datas(a.data, "/data", d);

  if (a.flows !== undefined) {
    if (!isObj(a.flows)) bad("/flows", "flows maps a name to a flow");
    else for (const [key, f] of Object.entries(a.flows)) flow(key, f, pointer("flows", key), d);
  }

  if (!Array.isArray(a.pages) || a.pages.length === 0) bad("/pages", "an application has at least one page");
  else {
    const names = new Set<string>();
    const paths = new Set<string>();
    const ids = new Set<string>();
    for (const [i, p] of (a.pages as unknown[]).entries()) {
      const at = pointer("pages", i);
      if (!isObj(p)) {
        bad(at, "a page is an object");
        continue;
      }
      known(p, ["name", "title", "path", "description", "params", "state", "data", "for", "nav", "layout"], at, d);
      if (typeof p.name !== "string" || !PASCAL.test(p.name)) d.error("invalid-name", `${at}/name`, "a page name is a PascalCase word", 'e.g. "ShipmentDetail"');
      else if (names.has(p.name)) d.error("duplicate-name", `${at}/name`, `page "${p.name}" is named twice`);
      else names.add(p.name);
      if (!isStr(p.title)) bad(`${at}/title`, "a page needs a title");
      if (typeof p.path !== "string" || !/^\/([a-z0-9-]+|:[a-z][A-Za-z0-9]*)?(\/([a-z0-9-]+|:[a-z][A-Za-z0-9]*))*$/.test(p.path)) bad(`${at}/path`, "a path is / or /segment/:param …", 'e.g. "/shipments/:id"');
      else {
        const shape = p.path.replace(/:[A-Za-z0-9]+/g, ":");
        if (paths.has(shape)) d.error("duplicate-name", `${at}/path`, `another page has the path ${p.path}`);
        paths.add(shape);
        const segs = [...p.path.matchAll(/:([A-Za-z0-9]+)/g)].map((m) => m[1]!);
        const params = isObj(p.params) ? Object.keys(p.params) : [];
        for (const s of segs) if (!params.includes(s)) d.error("page-param", `${at}/params`, `the path has :${s}, and the page declares no param "${s}"`, `add params.${s}: { "schema": { "type": "string" } }`);
        for (const s of params) if (!segs.includes(s)) d.error("page-param", pointer("pages", i, "params", s), `param "${s}" is not a :segment of ${p.path}`);
        // A param is a piece of the path, so it arrives as a string; typed as a number, every comparison with it would be unknown.
        for (const [s, v] of isObj(p.params) ? Object.entries(p.params) : [])
          if (isObj(v) && isObj(v.schema) && v.schema.type !== undefined && v.schema.type !== "string") d.error("page-param", pointer("pages", i, "params", s, "schema", "type"), `param "${s}" comes from the path, so it is a string`, '{ "type": "string" }, with a pattern or format if it must look a certain way');
      }
      if (p.params !== undefined) {
        if (!isObj(p.params)) bad(`${at}/params`, "params maps a name to { schema }");
        else for (const [k, v] of Object.entries(p.params)) if (!isObj(v) || !isObj(v.schema)) bad(pointer("pages", i, "params", k), "a param has a schema");
      }
      if (p.for !== undefined && (!Array.isArray(p.for) || p.for.some((c) => typeof c !== "string"))) bad(`${at}/for`, "for lists caller names");
      states(p.state, `${at}/state`, d);
      datas(p.data, `${at}/data`, d);
      if (!isObj(p.layout)) bad(`${at}/layout`, "a page has a layout node");
      else node(p.layout, `${at}/layout`, d, ids);
    }
  }

  if (!Array.isArray(a.acceptance) || a.acceptance.length === 0) bad("/acceptance", "an application has at least one acceptance check", "an application nothing can check is not done");
  else {
    const ids = new Set<string>();
    const kinds = ["reads", "refused", "query", "offered", "described", "starts", "approves", "screen"];
    for (const [i, c] of (a.acceptance as unknown[]).entries()) {
      const at = pointer("acceptance", i);
      if (!isObj(c)) {
        d.error("invalid-check", at, "a check is an object");
        continue;
      }
      if (!isStr(c.id)) d.error("invalid-check", `${at}/id`, "a check needs an id");
      else if (ids.has(c.id)) d.error("duplicate-name", `${at}/id`, `check "${c.id}" is named twice`);
      else ids.add(c.id);
      if (typeof c.kind !== "string" || !kinds.includes(c.kind)) d.error("invalid-check", `${at}/kind`, `a check is one of ${kinds.join(", ")}`);
      if (typeof c.as !== "string") d.error("invalid-check", `${at}/as`, "a check names the caller it runs as");
      // A misspelt assertion would be one the check never makes: it would pass having decided nothing.
      const fields = typeof c.kind === "string" ? CHECK_FIELDS[c.kind] : undefined;
      if (fields) known(c, ["id", "kind", "as", "because", ...fields], at, d);
      if (c.kind === "screen") {
        if (!isStr(c.page)) d.error("invalid-check", `${at}/page`, "a screen check names a page");
        const any = ["visible", "hidden", "text", "absentText", "rows"].some((k) => c[k] !== undefined);
        if (!any) d.error("invalid-check", at, "a screen check asserts something: visible, hidden, text, absentText or rows", "a check with nothing to decide passes on any screen");
        if (isObj(c.rows)) for (const [node, want] of Object.entries(c.rows)) if (isObj(want)) known(want, ["atLeast", "atMost"], `${at}/rows/${node}`, d);
      }
    }
  }
  return d.list;
}

/** The fields each kind of check has, beside id, kind, as and because. */
const CHECK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  reads: ["type", "objectId", "sees", "withheld"],
  refused: ["type", "objectId"],
  query: ["query", "atLeast", "atMost"],
  offered: ["type", "objectId", "action", "offered"],
  described: ["type", "described"],
  starts: ["workflow", "input", "status", "waitingOn", "failsAt"],
  approves: ["workflow", "startedBy", "input", "step", "admitted", "then"],
  screen: ["page", "params", "visible", "hidden", "text", "absentText", "rows"]
};

/** The document as an application, or every reason it is not one. */
export function parseApp(doc: unknown): { app: AppSpec; diagnostics: [] } | { app?: undefined; diagnostics: AppDiagnostic[] } {
  const diagnostics = appProblems(doc);
  return diagnostics.length > 0 ? { diagnostics } : { app: doc as AppSpec, diagnostics: [] };
}

/** An object's keys are among `allowed`; anything else is a typo or a field of another version, and is said to be. */
function known(o: Record<string, unknown>, allowed: readonly string[], at: string, d: Diagnostics): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    const near = didYouMean(k, allowed);
    d.error("invalid-app", `${at}/${k}`, `"${k}" is not a field here`, near ? `did you mean "${near}"?` : `fields: ${allowed.join(", ")}`);
  }
}

function states(v: unknown, at: string, d: Diagnostics): void {
  if (v === undefined) return;
  if (!isObj(v)) return d.error("invalid-app", at, "state maps a name to { schema, default }");
  for (const [k, s] of Object.entries(v)) {
    const sat = `${at}/${k}`;
    name(k, sat, d);
    if (!isObj(s) || !isObj(s.schema)) d.error("invalid-app", sat, "a state has a schema", '{ "schema": { "type": "string" }, "default": null }');
    else known(s, ["schema", "default", "description"], sat, d);
  }
}

function name(k: string, at: string, d: Diagnostics): void {
  if (!CAMEL.test(k)) d.error("invalid-name", at, `"${k}" is not a camelCase name`);
  else if (RESERVED.has(k)) d.error("reserved-name", at, `"${k}" is a reference scope`, "rename it");
}

function datas(v: unknown, at: string, d: Diagnostics): void {
  if (v === undefined) return;
  if (!isObj(v)) return d.error("invalid-app", at, "data maps a name to a read or a derive");
  for (const [k, x] of Object.entries(v)) {
    const dat = `${at}/${k}`;
    name(k, dat, d);
    if (!isObj(x)) {
      d.error("invalid-app", dat, "data are a read or a derive");
      continue;
    }
    if (x.kind === "derive") {
      known(x, ["kind", "value", "description", "refresh"], dat, d);
      if (!("value" in x)) d.error("invalid-app", `${dat}/value`, "a derive has a value");
    } else read(x, dat, d, ["description", "refresh"]);
    const r = (x as DataIR).refresh;
    if (r !== undefined && (!isObj(r) || (r.everyMs !== undefined && !whole(r.everyMs, 1000, 86_400_000)))) d.error("invalid-app", `${dat}/refresh`, "refresh.everyMs is a whole number of milliseconds from 1000 to a day");
  }
}

const READ_KINDS = ["query", "object", "related", "aggregate"];

function read(x: Record<string, unknown>, at: string, d: Diagnostics, extra: readonly string[] = []): void {
  if (typeof x.kind !== "string" || !READ_KINDS.includes(x.kind)) {
    d.error("invalid-app", `${at}/kind`, `a read is one of ${READ_KINDS.join(", ")}`, x.kind === undefined ? 'e.g. { "kind": "query", "query": { "type": "…" } }' : undefined);
    return;
  }
  const r = x as unknown as ReadIR;
  switch (r.kind) {
    case "query":
      known(x, ["kind", "query", ...extra], at, d);
      if (!isObj(r.query) || !isStr(r.query.type)) d.error("invalid-app", `${at}/query`, "a query names its type");
      else {
        known(r.query, ["type", "filter", "search", "sort", "select", "include", "limit", "all"], `${at}/query`, d);
        if (r.query.limit !== undefined && !whole(r.query.limit, 1, 1000)) d.error("invalid-app", `${at}/query/limit`, "limit is a whole number from 1 to 1000");
      }
      return;
    case "object":
      known(x, ["kind", "type", "id", "provenance", ...extra], at, d);
      if (!isStr(r.type)) d.error("invalid-app", `${at}/type`, "an object read names its type");
      if (!("id" in x)) d.error("invalid-app", `${at}/id`, "an object read names the id, usually a reference");
      return;
    case "related":
      known(x, ["kind", "of", "type", "relationship", ...extra], at, d);
      if (!isStr(r.type) || !isStr(r.relationship) || !("of" in x)) d.error("invalid-app", at, "a related read names the object (`of`), its `type`, and the `relationship`");
      return;
    case "aggregate":
      known(x, ["kind", "aggregate", ...extra], at, d);
      if (!isObj(r.aggregate) || !isStr(r.aggregate.type) || !Array.isArray(r.aggregate.aggregations) || r.aggregate.aggregations.length === 0) d.error("invalid-app", `${at}/aggregate`, "an aggregate names its type and at least one aggregation");
      return;
  }
}

function flow(key: string, f: unknown, at: string, d: Diagnostics): void {
  if (!CAMEL.test(key)) d.error("invalid-name", at, `flow key "${key}" is not a camelCase name`, "effects and forms refer to the flow by it");
  if (!isObj(f)) return d.error("invalid-app", at, "a flow is an object");
  known(f, ["name", "version", "title", "description", "startPolicy", "cancelPolicy", "about", "input", "steps"], at, d);
  if (f.about !== undefined && !isStr(f.about)) d.error("invalid-app", `${at}/about`, "about names one of the flow's inputs");
  if (typeof f.name !== "string" || !QUALIFIED.test(f.name)) d.error("invalid-name", `${at}/name`, "a flow's name is qualified like a Type", 'e.g. "coldchain.DispositionLot"');
  if (typeof f.version !== "string" || !/^\d+\.\d+\.\d+$/.test(f.version)) d.error("invalid-app", `${at}/version`, "version is semver, like 1.0.0");
  if (!isStr(f.startPolicy)) d.error("invalid-app", `${at}/startPolicy`, "a flow names the policy that admits who may start it");
  if (!isObj(f.input)) d.error("invalid-app", `${at}/input`, "input maps a field to { schema }", "{} for a flow that takes none");
  else for (const [k, v] of Object.entries(f.input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) d.error("invalid-name", `${at}/input/${k}`, `"${k}" is not an identifier`);
    if (!isObj(v) || !isObj(v.schema)) d.error("invalid-app", `${at}/input/${k}`, "an input has a schema");
  }
  if (!Array.isArray(f.steps) || f.steps.length === 0) return d.error("invalid-app", `${at}/steps`, "a flow has at least one step");
  const seen = new Set<string>();
  const stepAt = (i: number, j?: number) => `${at}/steps/${i}${j === undefined ? "" : `/steps/${j}`}`;
  for (const [i, s] of (f.steps as unknown[]).entries()) {
    step(s, stepAt(i), d, seen, false);
    if (isObj(s) && s.kind === "parallel" && Array.isArray(s.steps)) for (const [j, inner] of (s.steps as unknown[]).entries()) step(inner, stepAt(i, j), d, seen, true);
  }
}

function step(s: unknown, at: string, d: Diagnostics, seen: Set<string>, inParallel: boolean): void {
  if (!isObj(s)) return d.error("invalid-app", at, "a step is an object");
  const kinds = Object.keys(STEP_CATALOG);
  if (typeof s.kind !== "string" || !kinds.includes(s.kind)) return d.error("invalid-app", `${at}/kind`, `a step is one of ${kinds.join(", ")}`);
  if (inParallel && s.kind !== "read") d.error("unsupported", at, `a parallel step runs reads at once, and this is a ${s.kind}`, "only reads change nothing, so only reads may run in any order; put the rest after the parallel step");
  const spec = STEP_CATALOG[s.kind as StepIR["kind"]];
  known(s, [...Object.keys(STEP_BASE), ...Object.keys(spec.props)], at, d);
  if (typeof s.name !== "string" || !CAMEL.test(s.name)) d.error("invalid-name", `${at}/name`, "a step name is a camelCase word");
  else if (RESERVED.has(s.name)) d.error("reserved-name", `${at}/name`, `"${s.name}" is a reference scope`);
  else if (seen.has(s.name)) d.error("duplicate-name", `${at}/name`, `step "${s.name}" is named twice`);
  else seen.add(s.name);
  for (const [k, p] of Object.entries(spec.props)) if (p.required && !(k in s)) d.error("invalid-app", `${at}/${k}`, `a ${s.kind} step needs ${k}`, p.doc);
  if (s.retry !== undefined && (!isObj(s.retry) || !whole(s.retry.maxAttempts, 1, 10) || (s.retry.backoffMs !== undefined && !whole(s.retry.backoffMs, 0, 3_600_000))))
    d.error("invalid-app", `${at}/retry`, "retry is { maxAttempts: 1 to 10, backoffMs: 0 to an hour }");
  if ((s.kind === "read" || s.kind === "forEach") && isObj(s.read)) read(s.read, `${at}/read`, d);
  if (s.kind === "read" && s.timeoutMs !== undefined && !whole(s.timeoutMs, 1, 600_000)) d.error("invalid-app", `${at}/timeoutMs`, "timeoutMs is a whole number of milliseconds up to ten minutes");
  if (s.kind === "forEach" && !whole(s.max, 1, 500)) d.error("invalid-app", `${at}/max`, "max is a whole number from 1 to 500", "iteration is bounded: say how many elements the step may read");
  if (s.kind === "forEach" && s.concurrency !== undefined && !whole(s.concurrency, 1, 16)) d.error("invalid-app", `${at}/concurrency`, "concurrency is 1 to 16");
  if (s.kind === "approval") {
    if (!Array.isArray(s.present) || s.present.some((p) => typeof p !== "string")) d.error("invalid-app", `${at}/present`, "present lists earlier steps by name", "[] when the approver needs to be shown nothing");
    if (s.deadlineMs !== undefined && !whole(s.deadlineMs, 1)) d.error("invalid-app", `${at}/deadlineMs`, "deadlineMs is a whole number of milliseconds");
  }
  if (s.kind === "ai" && (typeof s.output !== "object" || s.output === null)) d.error("invalid-app", `${at}/output`, "an AI step's output is a JSON Schema object");
  if (s.kind === "action" && s.compensate !== undefined && (!isObj(s.compensate) || !isStr(s.compensate.action) || !isObj(s.compensate.input))) d.error("invalid-app", `${at}/compensate`, "compensate is { action, input }");
  if (s.kind === "parallel" && (!Array.isArray(s.steps) || s.steps.length < 2)) d.error("invalid-app", `${at}/steps`, "a parallel step runs at least two reads");
  if (s.kind === "parallel" && s.when !== undefined) d.error("unsupported", `${at}/when`, "a parallel step has no condition of its own", "give each read its own when");
}

const EFFECT_KEYS: Readonly<Record<string, readonly string[]>> = { set: ["set", "value"], run: ["run", "input", "into"], invoke: ["invoke", "input", "confirm"], navigate: ["navigate", "params"], refresh: ["refresh"] };

function effects(v: unknown, at: string, d: Diagnostics): void {
  if (!Array.isArray(v)) return d.error("invalid-app", at, "effects are a list");
  for (const [i, e] of v.entries()) {
    const eat = `${at}/${i}`;
    if (!isObj(e)) {
      d.error("invalid-app", eat, "an effect is an object");
      continue;
    }
    const kind = Object.keys(EFFECT_KEYS).find((k) => k in e);
    if (!kind) {
      d.error("invalid-app", eat, `an effect is one of ${Object.keys(EFFECT_KEYS).join(", ")}`);
      continue;
    }
    known(e, EFFECT_KEYS[kind]!, eat, d);
    const x = e as unknown as EffectIR;
    if ("set" in x && (!isStr(x.set) || !("value" in e))) d.error("invalid-app", eat, "set names a state and a value");
    if (("run" in x || "invoke" in x) && !isObj((e as { input?: unknown }).input)) d.error("invalid-app", `${eat}/input`, `${kind} takes an input object`, "{} when it takes none");
    if ("refresh" in x && (!Array.isArray(x.refresh) || x.refresh.some((r) => typeof r !== "string"))) d.error("invalid-app", `${eat}/refresh`, "refresh lists data names");
  }
}

/** One node and its children, against the catalog. */
function node(n: Record<string, unknown>, at: string, d: Diagnostics, ids: Set<string>): void {
  const kinds = Object.keys(NODE_CATALOG);
  if (typeof n.kind !== "string" || !kinds.includes(n.kind)) {
    const near = typeof n.kind === "string" ? didYouMean(n.kind, kinds) : undefined;
    return d.error("invalid-app", `${at}/kind`, `a node is one of ${kinds.join(", ")}`, near ? `did you mean "${near}"?` : undefined);
  }
  const spec = NODE_CATALOG[n.kind as NodeIR["kind"]];
  known(n, [...Object.keys(NODE_BASE), ...Object.keys(spec.props)], at, d);
  if (n.id !== undefined) {
    if (typeof n.id !== "string" || !NODE_ID.test(n.id)) d.error("invalid-name", `${at}/id`, "a node id is lower case words joined by - (or camelCase)");
    else if (ids.has(n.id)) d.error("duplicate-name", `${at}/id`, `node id "${n.id}" is used twice`, "ids are unique across the application, so a check names one node");
    else ids.add(n.id);
  }
  if (n.span !== undefined && !whole(n.span, 1, 12)) d.error("invalid-app", `${at}/span`, "span is 1 to 12");
  for (const [k, p] of Object.entries(spec.props)) {
    if (p.required && !(k in n)) d.error("invalid-app", `${at}/${k}`, `a ${n.kind} needs ${k}`, p.doc);
    if (k in n) prop(n[k], p, `${at}/${k}`, d, ids);
  }
  if (n.kind === "form" && (n.action === undefined) === (n.flow === undefined)) d.error("invalid-app", at, "a form names an action or a flow, not both");
}

function prop(v: unknown, p: PropSpec, at: string, d: Diagnostics, ids: Set<string>): void {
  const want = (ok: boolean, what: string) => {
    if (!ok) d.error("invalid-app", at, `expected ${what}`);
  };
  switch (p.kind) {
    case "string":
    case "data":
    case "state":
    case "field":
    case "flow":
    case "action":
    case "page":
    case "step":
      return want(isStr(v), "a non-empty string");
    case "number":
      return want(typeof v === "number" && Number.isFinite(v), "a number");
    case "boolean":
      return want(typeof v === "boolean", "true or false");
    case "enum":
      return want(typeof v === "string" && (p.values ?? []).includes(v), `one of ${(p.values ?? []).join(", ")}`);
    case "strings":
    case "fields":
      return want(Array.isArray(v) && v.length > 0 && v.every(isStr), "a non-empty list of strings");
    case "expr-map":
    case "schema-map":
    case "string-map":
      return want(isObj(v), "an object");
    case "schema":
      return want(isObj(v), "a JSON Schema object");
    case "band":
      return want(isObj(v) && "from" in v && "to" in v, "{ from, to, label }");
    case "expr":
      return;
    case "effects":
      return effects(v, at, d);
    case "node":
      return isObj(v) ? node(v, at, d, ids) : want(false, "a node");
    case "nodes":
      if (!Array.isArray(v)) return want(false, "a list of nodes");
      v.forEach((c, i) => (isObj(c) ? node(c, `${at}/${i}`, d, ids) : d.error("invalid-app", `${at}/${i}`, "expected a node")));
      return;
    case "tabs":
      if (!Array.isArray(v) || v.length === 0) return want(false, "a list of { label, content }");
      v.forEach((t, i) => {
        if (!isObj(t) || !isStr(t.label) || !isObj(t.content)) d.error("invalid-app", `${at}/${i}`, "a tab is { label, content }");
        else node(t.content, `${at}/${i}/content`, d, ids);
      });
      return;
    case "field-refs":
      if (!Array.isArray(v) || v.length === 0) return want(false, "a list of fields");
      v.forEach((f, i) => {
        if (isStr(f)) return;
        if (!isObj(f) || !isStr(f.field)) d.error("invalid-app", `${at}/${i}`, "a column is a field name or { field, label, format, tone }");
        else known(f, ["field", "label", "format", "tone"], `${at}/${i}`, d);
      });
      return;
    case "buttons":
    case "row-actions":
      if (!Array.isArray(v) || v.length === 0) return want(false, "a list of { label, do }");
      v.forEach((b, i) => {
        if (!isObj(b) || !isStr(b.label)) d.error("invalid-app", `${at}/${i}`, "a button is { label, do, when }");
        else {
          known(b, ["label", "do", "when", ...(p.kind === "buttons" ? ["tone"] : [])], `${at}/${i}`, d);
          effects(b.do, `${at}/${i}/do`, d);
        }
      });
      return;
  }
}

/** A design system `@typesys/ui` ships, or `<module>#<Export>` in src/extensions/: the same shape a custom component has. */
export const DESIGN_SYSTEM = /^(?:meridian|ledger|([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)#([A-Za-z_][A-Za-z0-9_]*))$/;

function design(v: unknown, d: Diagnostics): void {
  const bad = (at: string, message: string, hint?: string) => d.error("invalid-app", at, message, hint);
  if (!isObj(v)) return bad("/design", "design names a system", '"meridian" or "ledger", or <module>#<export> in src/extensions/');
  known(v, ["system", "tokens", "density", "brand", "signIn"], "/design", d);
  // The system is emitted as an import and an identifier, so only that shape is accepted: nothing else reaches the code.
  if (!isStr(v.system) || !DESIGN_SYSTEM.test(v.system)) bad("/design/system", "design.system is a shipped system or <module>#<export>", '"meridian", "ledger", or e.g. "brand/theme#overrides" for src/extensions/brand/theme.ts');
  if (v.tokens !== undefined && (!isObj(v.tokens) || Object.values(v.tokens).some((t) => typeof t !== "string"))) bad("/design/tokens", "design tokens map a token name to a CSS value");
  if (v.density !== undefined && v.density !== "comfortable" && v.density !== "compact") bad("/design/density", 'density is "comfortable" or "compact"');
  if (v.brand !== undefined && (!isObj(v.brand) || !isStr(v.brand.name) || (v.brand.mark !== undefined && typeof v.brand.mark !== "string"))) bad("/design/brand", "brand is { name, mark? }");
  if (v.signIn !== undefined && v.signIn !== "presets") bad("/design/signIn", 'signIn is "presets" when set');
}
