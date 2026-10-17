import { canonical } from "@typesys/core";
import { pointer } from "./diagnostics.js";
import type { AppCheck, AppSpec, FlowIR, NodeIR, PageIR, ReadIR, StepIR } from "./ir.js";
import type { Generated } from "./compile.js";

/** One change between two versions of an application, in its own terms rather than as lines of JSON. */
export interface AppChange {
  readonly change: "added" | "removed" | "changed";
  readonly what: "app" | "host" | "caller" | "model" | "design" | "state" | "data" | "page" | "node" | "flow" | "step" | "check";
  /** The JSON Pointer of the thing in the newer version (in the older one when removed). */
  readonly at: string;
  readonly name: string;
  /** What changed about it: the fields that differ. */
  readonly detail?: string;
  /** Why the change can break something that worked: a link, a run in flight, a check. */
  readonly risk?: string;
}

/** What a change reaches. */
export interface AppImpact {
  /** Generated files whose content changes, from generating both versions; empty when only the specifications were compared. */
  readonly files: readonly string[];
  /** Acceptance checks that exercise something that changed: the ones to run first. */
  readonly checks: readonly string[];
  /** Types the changed reads, data and steps read, and Actions they invoke. */
  readonly types: readonly string[];
  readonly actions: readonly string[];
}

export interface AppDiff {
  readonly changes: readonly AppChange[];
  readonly impact: AppImpact;
  /** One line per change, for a person or a commit message. */
  readonly summary: readonly string[];
}

type Keyed<T> = ReadonlyMap<string, { readonly value: T; readonly at: string }>;

const same = (a: unknown, b: unknown): boolean => canonical(a ?? null) === canonical(b ?? null);

/** The keys of two objects whose values differ. */
function differing(a: object, b: object, ignore: readonly string[] = []): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !ignore.includes(k)).sort();
  return keys.filter((k) => !same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function compareKeyed<T>(before: Keyed<T>, after: Keyed<T>, onChanged: (name: string, a: { value: T; at: string }, b: { value: T; at: string }) => void, onAdded: (name: string, b: { value: T; at: string }) => void, onRemoved: (name: string, a: { value: T; at: string }) => void): void {
  for (const [name, b] of after) {
    const a = before.get(name);
    if (!a) onAdded(name, b);
    else if (!same(a.value, b.value)) onChanged(name, a, b);
  }
  for (const [name, a] of before) if (!after.has(name)) onRemoved(name, a);
}

const record = <T>(obj: Readonly<Record<string, T>> | undefined, at: string): Keyed<T> => new Map(Object.entries(obj ?? {}).map(([k, v]) => [k, { value: v, at: `${at}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}` }]));

/** Every node with an id, by id, with where it is; a node without an id is compared as part of its parent. */
function nodesById(n: NodeIR, at: string, into = new Map<string, { value: NodeIR; at: string }>()): Map<string, { value: NodeIR; at: string }> {
  if (n.id) into.set(n.id, { value: shallow(n), at });
  if ("children" in n) n.children.forEach((c, i) => nodesById(c, `${at}/children/${i}`, into));
  if (n.kind === "tabs") n.tabs.forEach((t, i) => nodesById(t.content, `${at}/tabs/${i}/content`, into));
  return into;
}

/** A node without the nodes it holds: a change to a child is the child's change, unless the child has no id. */
function shallow(n: NodeIR): NodeIR {
  const strip = (c: NodeIR): unknown => (c.id ? { id: c.id } : shallowDeep(c));
  if ("children" in n) return { ...n, children: n.children.map(strip) } as unknown as NodeIR;
  if (n.kind === "tabs") return { ...n, tabs: n.tabs.map((t) => ({ ...t, content: strip(t.content) })) } as unknown as NodeIR;
  return n;
}
const shallowDeep = (n: NodeIR): unknown => shallow(n);

/** A layout with every node that has an id reduced to the id: what is left is the arrangement and the nodes without one. */
function arrangement(n: NodeIR, root = true): unknown {
  if (n.id && !root) return { id: n.id };
  const o: Record<string, unknown> = { ...n };
  if ("children" in n) o.children = n.children.map((c) => arrangement(c, false));
  if (n.kind === "tabs") o.tabs = n.tabs.map((t) => ({ ...t, content: arrangement(t.content, false) }));
  if (n.id) return { id: n.id, children: o.children, tabs: o.tabs };
  return o;
}

const flatSteps = (f: FlowIR): Map<string, { value: StepIR; at: string }> =>
  new Map(
    f.steps.flatMap((s, i) => {
      const at = `/steps/${i}`;
      return s.kind === "parallel" ? [[s.name, { value: { ...s, steps: s.steps.map((r) => ({ name: r.name })) } as unknown as StepIR, at }] as const, ...s.steps.map((r, j) => [r.name, { value: r, at: `${at}/steps/${j}` }] as const)] : [[s.name, { value: s, at }] as const];
    })
  );

const readType = (r: ReadIR): string => (r.kind === "query" ? r.query.type : r.kind === "aggregate" ? r.aggregate.type : r.type);

/** Types and Actions a piece of the specification reads or invokes, found by its shape. */
function touches(x: unknown, types: Set<string>, actions: Set<string>): void {
  if (Array.isArray(x)) return x.forEach((y) => touches(y, types, actions));
  if (!x || typeof x !== "object") return;
  const o = x as Record<string, unknown>;
  if (o.kind === "query" || o.kind === "object" || o.kind === "related" || o.kind === "aggregate") {
    try {
      types.add(readType(o as unknown as ReadIR));
    } catch {
      // Not a read after all.
    }
  }
  if (typeof o.invoke === "string") actions.add(o.invoke);
  if (o.kind === "action" && typeof o.action === "string") actions.add(o.action);
  if (o.kind === "form" && typeof o.action === "string") actions.add(o.action);
  for (const v of Object.values(o)) touches(v, types, actions);
}

/**
 * The semantic difference between two versions of an application
 * (ADR-0085): which pages, nodes, flows, steps, data, state, models,
 * callers and checks were added, removed or changed, what each change
 * risks, and what it reaches. With both versions' generated files, the
 * impact names exactly the files that change.
 */
export function diffApps(before: AppSpec, after: AppSpec, generated?: { readonly before: Generated; readonly after: Generated }): AppDiff {
  const changes: AppChange[] = [];
  const add = (c: AppChange) => changes.push(c);
  const changedPages = new Set<string>();
  const changedFlows = new Set<string>();
  const changedCallers = new Set<string>();
  const types = new Set<string>();
  const actions = new Set<string>();

  const top = differing(before, after, ["host", "callers", "models", "design", "state", "data", "flows", "pages", "acceptance"]);
  if (top.length) add({ change: "changed", what: "app", at: "", name: after.name, detail: top.join(", ") });
  if (!same(before.host, after.host)) add({ change: "changed", what: "host", at: "/host", name: after.host.module, detail: differing(before.host, after.host).join(", "), risk: "the model, the policies and the identities may all differ: check and verify everything again" });
  compareKeyed(
    record(before.callers, "/callers"),
    record(after.callers, "/callers"),
    (name, _a, b) => (changedCallers.add(name), add({ change: "changed", what: "caller", at: b.at, name, detail: "token" })),
    (name, b) => (changedCallers.add(name), add({ change: "added", what: "caller", at: b.at, name })),
    (name, a) => (changedCallers.add(name), add({ change: "removed", what: "caller", at: a.at, name, risk: "checks and pages that name this caller no longer resolve" }))
  );
  compareKeyed(
    record(before.models, "/models"),
    record(after.models, "/models"),
    (name, a, b) => add({ change: "changed", what: "model", at: b.at, name, detail: differing(a.value, b.value).join(", "), risk: "an AI step asks a different model, whose audience may be released less" }),
    (name, b) => add({ change: "added", what: "model", at: b.at, name }),
    (name, a) => add({ change: "removed", what: "model", at: a.at, name })
  );
  if (!same(before.design, after.design)) add({ change: "changed", what: "design", at: "/design", name: after.design?.system ?? "meridian", detail: differing(before.design ?? {}, after.design ?? {}).join(", ") });
  const usesRef = (scope: "state" | "data", name: string, x: unknown): boolean => {
    const text = JSON.stringify(x);
    return scope === "state" ? text.includes(`"$state.${name}`) : text.includes(`"$${name}`) || new RegExp(`"(data|root)":"${name}"`).test(text);
  };
  for (const [scope, a, b] of [
    ["state", before.state, after.state],
    ["data", before.data, after.data]
  ] as const) {
    compareKeyed(
      record<unknown>(a, `/${scope}`),
      record<unknown>(b, `/${scope}`),
      (name, x, y) => {
        add({ change: "changed", what: scope, at: y.at, name, detail: differing(x.value as object, y.value as object).join(", ") });
        if (scope === "data") touches([x.value, y.value], types, actions);
        after.pages.filter((p) => usesRef(scope, name, p)).forEach((p) => changedPages.add(p.name));
      },
      (name, y) => add({ change: "added", what: scope, at: y.at, name }),
      (name, x) => {
        add({ change: "removed", what: scope, at: x.at, name });
        before.pages.filter((p) => usesRef(scope, name, p)).forEach((p) => changedPages.add(p.name));
      }
    );
  }

  const pages = (s: AppSpec): Keyed<PageIR> => new Map(s.pages.map((p, i) => [p.name, { value: p, at: pointer("pages", i) }]));
  compareKeyed(
    pages(before),
    pages(after),
    (name, a, b) => {
      changedPages.add(name);
      const fields = differing(a.value, b.value, ["layout"]);
      if (fields.length) add({ change: "changed", what: "page", at: b.at, name, detail: fields.join(", "), ...(fields.includes("path") || fields.includes("params") ? { risk: "links and bookmarks to this page change" } : {}) });
      const na = nodesById(a.value.layout, `${a.at}/layout`);
      const nb = nodesById(b.value.layout, `${b.at}/layout`);
      compareKeyed(
        na,
        nb,
        (id, x, y) => (touches(x.value, types, actions), touches(y.value, types, actions), add({ change: "changed", what: "node", at: y.at, name: `${name}/${id}`, detail: `${y.value.kind}: ${differing(x.value, y.value).join(", ")}` })),
        (id, y) => (touches(y.value, types, actions), add({ change: "added", what: "node", at: y.at, name: `${name}/${id}`, detail: y.value.kind })),
        (id, x) => add({ change: "removed", what: "node", at: x.at, name: `${name}/${id}`, detail: x.value.kind, risk: "a screen check, test or extension that names this node no longer finds it" })
      );
      // Nodes without an id, and where the nodes with one sit, are the layout's own: compared with every id'd node reduced to its id.
      if (!same(arrangement(a.value.layout), arrangement(b.value.layout))) add({ change: "changed", what: "node", at: `${b.at}/layout`, name: `${name}/layout`, detail: "arrangement, or a node without an id" });
      if (!same(a.value.data, b.value.data)) touches([a.value.data, b.value.data], types, actions);
    },
    (name, b) => (changedPages.add(name), touches(b.value, types, actions), add({ change: "added", what: "page", at: b.at, name })),
    (name, a) => (changedPages.add(name), add({ change: "removed", what: "page", at: a.at, name, risk: "links to it and screen checks of it break" }))
  );

  compareKeyed(
    record(before.flows, "/flows"),
    record(after.flows, "/flows"),
    (key, a, b) => {
      changedFlows.add(a.value.name);
      changedFlows.add(b.value.name);
      const fields = differing(a.value, b.value, ["steps"]);
      const sa = flatSteps(a.value);
      const sb = flatSteps(b.value);
      const stepsChanged = !same(a.value.steps, b.value.steps) || !same(a.value.input, b.value.input);
      const unversioned = stepsChanged && a.value.version === b.value.version;
      if (fields.length || unversioned) add({ change: "changed", what: "flow", at: b.at, name: b.value.name, detail: fields.join(", ") || "steps", ...(unversioned ? { risk: `its steps changed and its version did not: runs in flight resume on the new steps as ${b.value.version}. Give it a new version` } : {}) });
      compareKeyed(
        sa,
        sb,
        (step, x, y) => (touches(x.value, types, actions), touches(y.value, types, actions), add({ change: "changed", what: "step", at: `${b.at}${y.at}`, name: `${key}/${step}`, detail: `${y.value.kind}: ${differing(x.value, y.value).join(", ")}` })),
        (step, y) => (touches(y.value, types, actions), add({ change: "added", what: "step", at: `${b.at}${y.at}`, name: `${key}/${step}`, detail: y.value.kind })),
        (step, x) => add({ change: "removed", what: "step", at: `${a.at}${x.at}`, name: `${key}/${step}`, detail: x.value.kind, risk: "a later step or check that names it no longer finds it" })
      );
      const order = (m: Map<string, unknown>) => [...m.keys()].join(",");
      if (order(sa) !== order(sb) && [...sa.keys()].every((k) => sb.has(k)) && sa.size === sb.size) add({ change: "changed", what: "flow", at: `${b.at}/steps`, name: b.value.name, detail: "step order", risk: "a run's steps happen in a different order" });
    },
    (_key, b) => (changedFlows.add(b.value.name), touches(b.value, types, actions), add({ change: "added", what: "flow", at: b.at, name: b.value.name })),
    (_key, a) => (changedFlows.add(a.value.name), add({ change: "removed", what: "flow", at: a.at, name: a.value.name, risk: "runs in flight can no longer be resumed by this application" }))
  );
  // A page that starts, shows or decides a changed flow is reached by it.
  const flowKeysChanged = new Set(Object.entries({ ...before.flows, ...after.flows }).filter(([, f]) => changedFlows.has(f.name)).map(([k]) => k));
  for (const p of after.pages) {
    const text = JSON.stringify(p.layout);
    if ([...flowKeysChanged].some((k) => text.includes(`"run":"${k}"`) || text.includes(`"flow":"${k}"`)) || (text.includes('"kind":"approvals"') && flowKeysChanged.size > 0)) changedPages.add(p.name);
  }

  const checks = (s: AppSpec): Keyed<AppCheck> => new Map(s.acceptance.map((c, i) => [c.id, { value: c, at: pointer("acceptance", i) }]));
  const changedChecks = new Set<string>();
  compareKeyed(
    checks(before),
    checks(after),
    (id, a, b) => (changedChecks.add(id), add({ change: "changed", what: "check", at: b.at, name: id, detail: differing(a.value, b.value).join(", ") })),
    (id, b) => (changedChecks.add(id), add({ change: "added", what: "check", at: b.at, name: id })),
    (id, a) => add({ change: "removed", what: "check", at: a.at, name: id, risk: "what it proved is no longer proved" })
  );

  // The checks to run first: new or changed ones, and every one that exercises a changed page, flow, caller or Type.
  const reached = after.acceptance.filter((c) => {
    if (changedChecks.has(c.id) || changedCallers.has(c.as)) return true;
    if (c.kind === "screen") return changedPages.has(c.page);
    if (c.kind === "starts" || c.kind === "approves") return changedFlows.has(c.workflow);
    if (c.kind === "reads" || c.kind === "refused") return types.has(c.type);
    if (c.kind === "query") return types.has(c.query.type);
    if (c.kind === "offered") return actions.has(c.action);
    return false;
  });
  const hostChanged = !same(before.host, after.host);

  let files: string[] = [];
  if (generated) {
    const all = new Set([...generated.before.owned.keys(), ...generated.after.owned.keys()]);
    files = [...all].filter((f) => generated.before.owned.get(f) !== generated.after.owned.get(f)).sort();
  }
  const verb = { added: "+", removed: "-", changed: "~" } as const;
  return {
    changes,
    impact: { files, checks: (hostChanged ? after.acceptance : reached).map((c) => c.id), types: [...types].sort(), actions: [...actions].sort() },
    summary: changes.map((c) => `${verb[c.change]} ${c.what} ${c.name}${c.detail ? ` (${c.detail})` : ""}${c.risk ? `: ${c.risk}` : ""}`)
  };
}
