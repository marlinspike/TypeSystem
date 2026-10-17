import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { ModelInspection } from "@typesys/core";
import type { GraphNode, GraphNodeKind } from "@typesys/devkit";
import type { GraphReach, GraphView as View, StudioApi } from "./api.js";
import { ErrorNote } from "./ErrorNote.js";
import { InspectorPanel } from "./InspectorPanel.js";

const KINDS: readonly GraphNodeKind[] = ["type", "member", "relationship", "action", "source", "policy", "marking", "workflow", "app", "part"];
const KIND_LABEL: Record<GraphNodeKind, string> = {
  type: "Types",
  member: "Values",
  relationship: "Relationships",
  action: "Actions",
  source: "Sources",
  policy: "Policies",
  marking: "Markings",
  workflow: "Workflows",
  app: "Applications",
  part: "Steps, pages, checks"
};

/** Colors from the stylesheet's own tokens, so the canvas follows light and dark mode. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { text: v("--text", "#1d1d1b"), muted: v("--muted", "#6b6b66"), line: v("--line", "#deded8"), panel: v("--panel", "#ffffff"), accent: v("--accent", "#1f5fbf"), warn: v("--warn", "#9a6200"), error: v("--error", "#b3261e") };
}

function stylesheet(): cytoscape.StylesheetJson {
  const c = palette();
  const kind = (k: GraphNodeKind, color: string, shape: cytoscape.Css.NodeShape) => ({ selector: `node[kind = "${k}"]`, style: { "background-color": color, shape } });
  return [
    { selector: "node", style: { label: "data(label)", color: c.text, "font-size": 11, "text-valign": "bottom", "text-margin-y": 4, width: 18, height: 18, "border-width": 1, "border-color": c.line, "text-wrap": "ellipsis", "text-max-width": "140px" } },
    kind("type", "#4f7fd1", "round-rectangle"),
    kind("member", "#7fa8e8", "ellipse"),
    kind("relationship", "#9b7fd1", "diamond"),
    kind("action", "#d18a4f", "hexagon"),
    kind("source", "#4fa37a", "barrel"),
    kind("policy", "#c4573f", "octagon"),
    kind("marking", "#a63d7a", "tag"),
    kind("workflow", "#3f8fa6", "round-rectangle"),
    kind("app", "#5e6bb5", "round-rectangle"),
    kind("part", "#8ab8c8", "round-triangle"),
    { selector: "node[?unresolved]", style: { "border-style": "dashed", "border-color": c.error, "background-opacity": 0.3 } },
    { selector: "node[?opaque]", style: { "border-style": "dotted", "border-width": 2, "border-color": c.warn } },
    { selector: "node[?more]", style: { "border-width": 2, "border-color": c.muted } },
    { selector: "edge", style: { width: 1.2, "line-color": c.line, "target-arrow-color": c.line, "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.8, label: "data(label)", "font-size": 9, color: c.muted, "text-rotation": "autorotate" } },
    { selector: "edge[?quiet]", style: { label: "" } },
    { selector: 'edge[kind = "contains"]', style: { "line-style": "dotted", "target-arrow-shape": "none", label: "" } },
    { selector: 'edge[basis = "inferred"]', style: { "line-style": "dashed" } },
    { selector: 'edge[kind = "guarded-by"], edge[kind = "marked"]', style: { "line-color": c.error, "target-arrow-color": c.error } },
    { selector: 'edge[kind = "derives-from"], edge[kind = "released-from"]', style: { "line-color": c.accent, "target-arrow-color": c.accent } },
    { selector: ":selected", style: { "border-width": 3, "border-color": c.accent } }
  ];
}

/** Rings from the center out: in the overview by kind (Types in the middle), in a neighborhood by hops from the node opened. */
const OVERVIEW_RING: Partial<Record<GraphNodeKind, number>> = { type: 4, action: 3, workflow: 2, app: 2, source: 1, policy: 1, marking: 1 };

function rings(view: View, focus: string | null): Map<string, number> {
  if (!focus) return new Map(view.nodes.map((n) => [n.id, OVERVIEW_RING[n.kind] ?? 0]));
  const near = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (near.get(a) ?? near.set(a, []).get(a)!).push(b);
    (near.get(b) ?? near.set(b, []).get(b)!).push(a);
  };
  for (const e of view.edges) link(e.from, e.to);
  for (const n of view.nodes) if (n.parent) link(n.parent, n.id);
  const hops = new Map([[focus, 0]]);
  const queue = [focus];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const next of near.get(at) ?? [])
      if (!hops.has(next)) {
        hops.set(next, hops.get(at)! + 1);
        queue.push(next);
      }
  }
  return new Map(view.nodes.map((n) => [n.id, 10 - (hops.get(n.id) ?? 9)]));
}

function elements(view: View, hidden: ReadonlySet<GraphNodeKind>, ring: ReadonlyMap<string, number>, labelled: boolean): ElementDefinition[] {
  const nodes = view.nodes.filter((n) => !hidden.has(n.kind));
  const shown = new Set(nodes.map((n) => n.id));
  const more = new Set(view.more);
  return [
    ...nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.label,
        kind: n.kind,
        ring: ring.get(n.id) ?? 0,
        ...(n.unresolved ? { unresolved: true } : {}),
        ...(n.detail?.opaque !== undefined ? { opaque: true } : {}),
        ...(more.has(n.id) ? { more: true } : {})
      }
    })),
    ...view.edges
      .filter((e) => shown.has(e.from) && shown.has(e.to))
      .map((e) => ({ data: { id: `${e.from}|${e.kind}|${e.to}|${e.how ?? ""}`, source: e.from, target: e.to, kind: e.kind, basis: e.basis, label: e.count && e.count > 1 ? `${e.kind} ×${e.count}` : e.kind, ...(labelled ? {} : { quiet: true }) } })),
    // Containment is drawn as a dotted line rather than nesting, which keeps every layout readable.
    ...nodes.filter((n) => n.parent && shown.has(n.parent)).map((n) => ({ data: { id: `${n.parent}|contains|${n.id}`, source: n.parent!, target: n.id, kind: "contains", basis: "declared", label: "" } }))
  ];
}

/**
 * The dependency graph (ADR-0090), opened progressively: an overview of
 * Types, sources, policies and consumers first, then the neighborhood of
 * whatever is selected, with what depends on it and what it rests on. The
 * graph is what the API builds for the signed-in caller: from an inspection
 * for someone who may inspect, from the description for anyone else.
 */
export function GraphView(props: { readonly api: StudioApi; readonly focus: string | null; readonly onExplain: (node: GraphNode) => void }) {
  const { api } = props;
  const container = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [mode, setMode] = useState<{ kind: "overview" } | { kind: "neighborhood"; node: string; depth: number }>(props.focus ? { kind: "neighborhood", node: props.focus, depth: 1 } : { kind: "overview" });
  const [selected, setSelected] = useState<string | null>(props.focus);
  const [reach, setReach] = useState<GraphReach | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<GraphNodeKind>>(new Set());
  const [search, setSearch] = useState("");
  const [inspection, setInspection] = useState<ModelInspection | null>(null);
  const [error, setError] = useState<unknown>(null);
  /** The whole graph, for finding a node by name and drawing a dependency walk: loaded when first needed, since the overview folds members and steps away. */
  const [full, setFull] = useState<View | null>(null);
  const index = full?.nodes ?? null;

  useEffect(() => {
    let live = true;
    setError(null);
    (mode.kind === "overview" ? api.graph("overview") : api.graph("neighborhood", mode.node, { depth: mode.depth, limit: 80 })).then(
      (v) => live && setView(v),
      (err: unknown) => live && setError(err)
    );
    return () => {
      live = false;
    };
  }, [api, mode]);

  // The inspection of the selected Type, for the panel: only for someone the graph was built from an inspection for.
  const selectedNode = view?.nodes.find((n) => n.id === selected) ?? index?.find((n) => n.id === selected) ?? null;
  const typeName = selectedNode ? (selectedNode.kind === "type" ? selectedNode.label : selectedNode.parent?.startsWith("type:") ? selectedNode.parent.slice(5) : null) : null;
  useEffect(() => {
    setInspection(null);
    if (!typeName || view?.structure !== "inspection" || selectedNode?.unresolved) return;
    let live = true;
    api.inspection([typeName]).then(
      (i) => live && setInspection(i),
      () => live && setInspection(null)
    );
    return () => {
      live = false;
    };
  }, [api, typeName, view?.structure, selectedNode?.unresolved]);

  // A dependency walk is drawn on its own: the subject in the middle, each ring one hop further out.
  const shown = useMemo<{ view: View; ring: Map<string, number> } | null>(() => {
    if (reach && full) {
      const ids = new Set([reach.subject, ...reach.reached.map((r) => r.id)]);
      const ring = new Map([[reach.subject, 100], ...reach.reached.map((r): [string, number] => [r.id, 100 - r.distance])]);
      return { view: { ...full, nodes: full.nodes.filter((n) => ids.has(n.id)), edges: full.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), more: [] }, ring };
    }
    return view ? { view, ring: rings(view, mode.kind === "neighborhood" ? mode.node : null) } : null;
  }, [reach, full, view, mode]);
  const els = useMemo(() => (shown ? elements(shown.view, hidden, shown.ring, mode.kind === "neighborhood" || reach !== null) : []), [shown, hidden, mode, reach]);

  useEffect(() => {
    if (!container.current || !shown) return;
    const instance = cytoscape({
      container: container.current,
      elements: els,
      style: stylesheet(),
      layout: { name: "concentric", animate: false, concentric: (n) => Number(n.data("ring")), levelWidth: () => 1, minNodeSpacing: mode.kind === "overview" && !reach ? 46 : 70, spacingFactor: 1.1, padding: 40 },
      wheelSensitivity: 0.3,
      minZoom: 0.1,
      // A small neighborhood is not blown up to fill the canvas.
      maxZoom: 1.4
    });
    const idOf = (e: cytoscape.EventObject) => String((e.target as cytoscape.NodeSingular).id());
    instance.on("tap", "node", (e) => setSelected(idOf(e)));
    instance.on("dbltap", "node", (e) => (setReach(null), setMode({ kind: "neighborhood", node: idOf(e), depth: 1 })));
    cy.current = instance;
    return () => {
      instance.destroy();
      cy.current = null;
    };
  }, [els, shown, mode, reach]);

  // What a dependency walk reached is highlighted, everything else faded.
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    if (selected) c.$id(selected).select();
  }, [selected, els]);

  const walk = (direction: "dependents" | "dependencies") => {
    if (!selected) return;
    setError(null);
    Promise.all([api.graph(direction, selected), full ?? api.graph("full")]).then(([r, f]) => (setFull(f), setReach(r)), setError);
  };

  useEffect(() => {
    if (search.trim() === "" || full) return;
    let live = true;
    api.graph("full").then(
      (g) => live && setFull(g),
      (err: unknown) => live && setError(err)
    );
    return () => {
      live = false;
    };
  }, [api, search, full]);

  const matches = search.trim() === "" || !index ? [] : index.filter((n) => n.label.toLowerCase().includes(search.toLowerCase()) || n.id.toLowerCase().includes(search.toLowerCase())).slice(0, 12);

  return (
    <div className="graph-split">
      <aside>
        <div className="row">
          <button className={mode.kind === "overview" ? "on" : ""} onClick={() => (setMode({ kind: "overview" }), setReach(null))}>
            Overview
          </button>
          {mode.kind === "neighborhood" && (
            <>
              <span className="muted">Neighborhood, depth</span>
              <select aria-label="Depth" value={mode.depth} onChange={(e) => setMode({ ...mode, depth: Number(e.target.value) })}>
                {[1, 2, 3].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </>
          )}
        </div>
        <input type="search" placeholder="Find a node" aria-label="Find a node" value={search} onChange={(e) => setSearch(e.target.value)} />
        {matches.length > 0 && (
          <ul className="list" data-testid="graph-matches">
            {matches.map((n) => (
              <li key={n.id}>
                <button onClick={() => (setSelected(n.id), setMode({ kind: "neighborhood", node: n.id, depth: 1 }), setSearch(""))}>
                  <span className="badge">{n.kind}</span> {n.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        <h3>Show</h3>
        <ul className="list kinds">
          {KINDS.map((k) => (
            <li key={k}>
              <label className="check">
                <input type="checkbox" checked={!hidden.has(k)} onChange={() => setHidden((h) => (h.has(k) ? new Set([...h].filter((x) => x !== k)) : new Set([...h, k])))} />
                {KIND_LABEL[k]}
                {view?.counts?.[k] !== undefined && <span className="muted"> {view.counts[k]}</span>}
              </label>
            </li>
          ))}
        </ul>
        {view && (
          <p className="muted" data-testid="graph-structure">
            {view.structure === "inspection" ? "Built from an inspection: sources, policies and markings are shown." : "Built from the model's description: you may not inspect, so sources, policies and markings are withheld."}
          </p>
        )}
        <p className="muted">Click to select, double-click to open a node's neighborhood. A dashed border is something a consumer uses that the model does not describe to you; a dotted one reads through code that declares nothing.</p>
      </aside>
      <section className="canvas-wrap">
        <ErrorNote error={error} />
        <div ref={container} className="canvas" data-testid="graph-canvas" role="img" aria-label="Dependency graph" />
      </section>
      <InspectorPanel
        node={selectedNode}
        inspection={inspection}
        reach={reach}
        onWalk={walk}
        onClear={() => setReach(null)}
        onOpen={(id) => (setSelected(id), setReach(null), setMode({ kind: "neighborhood", node: id, depth: 1 }))}
        onExplain={props.onExplain}
      />
    </div>
  );
}
