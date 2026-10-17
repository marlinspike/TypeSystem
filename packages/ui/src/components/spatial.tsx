import { useEffect, useMemo, useState } from "react";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { geoAlbersUsa, geoNaturalEarth1, geoPath, type GeoProjection } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import usStates from "us-atlas/states-10m.json";
import worldCountries from "world-atlas/countries-110m.json";
import type { Data } from "../data.js";
import { humanize, isTone } from "../format.js";
import { useRuntime } from "../runtime.js";
import { EmptyState, ErrorNote, Frame, useOverride, type NodeProps } from "../states.js";

const W = 960;
const H = 560;

export interface MapPoint {
  readonly id: string;
  readonly lat: number | undefined;
  readonly lon: number | undefined;
  readonly label: string | undefined;
  readonly tone?: unknown;
}

export interface MapProps extends NodeProps {
  readonly data: Data<readonly unknown[]>;
  readonly points: readonly MapPoint[];
  readonly region?: "us" | "world";
  readonly selected?: string | null;
  readonly onSelect?: (id: string) => void;
}

/** The outline a map draws, computed once per region: an offline atlas, no tile server. */
function useOutline(region: "us" | "world"): { projection: GeoProjection; land: string; borders: string } {
  return useMemo(() => {
    const topo = (region === "us" ? usStates : worldCountries) as unknown as Topology;
    const key = region === "us" ? "states" : "countries";
    const collection = topo.objects[key] as GeometryCollection;
    const shapes = feature(topo, collection);
    const projection = (region === "us" ? geoAlbersUsa() : geoNaturalEarth1()).fitSize([W, H], shapes);
    const path = geoPath(projection);
    return { projection, land: path(shapes) ?? "", borders: path(mesh(topo, collection, (a, b) => a !== b)) ?? "" };
  }, [region]);
}

function MapBuiltIn(props: MapProps) {
  const { projection, land, borders } = useOutline(props.region ?? "us");
  const placed = props.points.flatMap((p) => {
    if (typeof p.lat !== "number" || typeof p.lon !== "number") return [];
    const xy = projection([p.lon, p.lat]);
    return xy ? [{ ...p, x: xy[0], y: xy[1] }] : [];
  });
  const hidden = props.points.length - placed.length;
  return (
    <Frame {...props} kind="map" pending={[props.data, ...(props.pending ?? [])]}>
      <svg className="ts-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${props.title ?? "Map"}: ${placed.length} places`}>
        <path d={land} className="ts-map-land" />
        <path d={borders} className="ts-map-borders" />
        {placed.map((p) => {
          const tone = isTone(p.tone) ? p.tone : "info";
          const selected = props.selected === p.id;
          return (
            <g
              key={p.id}
              className="ts-map-point"
              data-tone={tone}
              data-point={p.id}
              aria-selected={selected}
              transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}
              tabIndex={props.onSelect ? 0 : undefined}
              role={props.onSelect ? "button" : undefined}
              aria-label={p.label ?? p.id}
              onClick={props.onSelect ? () => props.onSelect!(p.id) : undefined}
              onKeyDown={props.onSelect ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), props.onSelect!(p.id)) : undefined}
            >
              {tone === "bad" ? <circle r={16} className="ts-map-pulse" /> : null}
              <circle r={selected ? 9 : 7} />
              <title>{p.label ?? p.id}</title>
              {selected || tone === "bad" ? (
                <text x={p.x > W - 160 ? -12 : 12} y={4} textAnchor={p.x > W - 160 ? "end" : "start"}>
                  {p.label ?? p.id}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hidden > 0 ? <p className="ts-muted">{hidden} without a location you may see.</p> : null}
    </Frame>
  );
}

/** Points on an offline map; selecting one sets state. A point whose position is withheld is counted, not guessed. */
export function MapView(props: MapProps) {
  const C = useOverride("Map", MapBuiltIn);
  return <C {...props} />;
}

/** A relationship the graph may follow, resolved by the compiler against the model. */
export interface GraphEdgeSpec {
  readonly from: string;
  readonly name: string;
  readonly target: string;
}

interface GNode extends SimulationNodeDatum {
  readonly key: string;
  readonly type: string;
  readonly id: string;
  readonly label: string;
  expanded: boolean;
}
interface GLink extends SimulationLinkDatum<GNode> {
  readonly key: string;
  readonly name: string;
}

export interface GraphProps extends NodeProps {
  readonly root: Data<Readonly<Record<string, unknown>> | null>;
  readonly relationships: readonly GraphEdgeSpec[];
  /** Type → the field shown as each node's label. */
  readonly labels?: Readonly<Record<string, string>>;
}

const keyOf = (type: string, id: string) => `${type}/${id}`;
/** A node's label as drawn, short enough not to run over its neighbours; the whole label is its title. */
const clip = (s: string) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);

/** A small offset from a key, the same every time: a new node starts beside its parent, never at random. */
function jitter(key: string, axis: number): number {
  let h = 2166136261 ^ axis;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967295 - 0.5) * 20;
}

function GraphBuiltIn(props: GraphProps) {
  const { client } = useRuntime();
  const root = props.root.value;
  const [nodes, setNodes] = useState<GNode[]>([]);
  const [links, setLinks] = useState<GLink[]>([]);
  const [error, setError] = useState<Error | undefined>();
  const [busy, setBusy] = useState(false);
  const labelOf = (type: string, row: Readonly<Record<string, unknown>>) => String(row[props.labels?.[type] ?? ""] ?? row.$id);

  const expand = async (node: GNode, base: { nodes: GNode[]; links: GLink[] }) => {
    const rels = props.relationships.filter((r) => r.from === node.type);
    const ns = [...base.nodes];
    const ls = [...base.links];
    node.expanded = true;
    // Each relationship read through the runtime as the caller: what they may not read never appears.
    const answers = await Promise.allSettled(rels.map(async (r) => ({ r, rows: await client.related(node.type as never, node.id, r.name as never) })));
    for (const a of answers) {
      if (a.status === "rejected") continue;
      for (const row of a.value.rows as Readonly<Record<string, unknown>>[]) {
        const k = keyOf(a.value.r.target, String(row.$id));
        if (!ns.some((n) => n.key === k)) ns.push({ key: k, type: a.value.r.target, id: String(row.$id), label: labelOf(a.value.r.target, row), expanded: false, x: (node.x ?? 0) + jitter(k, 0), y: (node.y ?? 0) + jitter(k, 1) });
        const lk = `${node.key}>${a.value.r.name}>${k}`;
        if (!ls.some((l) => l.key === lk)) ls.push({ key: lk, name: a.value.r.name, source: node.key, target: k });
      }
    }
    return layout(ns, ls);
  };

  useEffect(() => {
    if (!root) return;
    const type = String(root.$type);
    const start: GNode = { key: keyOf(type, String(root.$id)), type, id: String(root.$id), label: labelOf(type, root), expanded: false, x: 0, y: 0 };
    setBusy(true);
    expand(start, { nodes: [start], links: [] }).then(
      (g) => (setNodes(g.nodes), setLinks(g.links), setBusy(false)),
      (e: Error) => (setError(e), setBusy(false))
    );
    // Laid out again only for a new root or a new caller, not on every render of the same one.
  }, [root?.$id, client]);

  const onNode = (n: GNode) => {
    if (n.expanded || busy) return;
    setBusy(true);
    expand(n, { nodes, links }).then(
      (g) => (setNodes(g.nodes), setLinks(g.links), setBusy(false)),
      (e: Error) => (setError(e), setBusy(false))
    );
  };
  const types = [...new Set(nodes.map((n) => n.type))];
  const color = (t: string) => `var(--ts-series-${(types.indexOf(t) % 5) + 1})`;
  const box = bounds(nodes);
  return (
    <Frame {...props} kind="graph" pending={[props.root]}>
      {error ? <ErrorNote error={error} /> : null}
      {!root ? (
        <EmptyState>Nothing selected.</EmptyState>
      ) : (
        <>
          <svg className="ts-graph" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} role="img" aria-label={`${nodes.length} related objects`} aria-busy={busy}>
            {links.map((l) => {
              const s = l.source as GNode;
              const t = l.target as GNode;
              return <line key={l.key} x1={s.x} y1={s.y} x2={t.x} y2={t.y} className="ts-graph-edge" />;
            })}
            {nodes.map((n) => (
              <g key={n.key} transform={`translate(${(n.x ?? 0).toFixed(1)},${(n.y ?? 0).toFixed(1)})`} className="ts-graph-node" data-expanded={n.expanded} data-graph-node={n.key} tabIndex={0} role="button" aria-label={`${humanize(n.type.split(".").pop() ?? n.type)} ${n.label}${n.expanded ? "" : ", expand"}`} onClick={() => onNode(n)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onNode(n))}>
                <circle r={n.key === nodes[0]?.key ? 18 : 12} fill={color(n.type)} />
                <title>{n.label}</title>
                <text y={n.key === nodes[0]?.key ? 32 : 26} textAnchor="middle">
                  {clip(n.label)}
                </text>
              </g>
            ))}
          </svg>
          <ul className="ts-legend">
            {types.map((t) => (
              <li key={t}>
                <span className="ts-swatch" data-series={(types.indexOf(t) % 5) + 1} /> {humanize(t.split(".").pop() ?? t)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Frame>
  );
}

/** Runs the force layout to rest, synchronously: the same graph lays out the same way, and nothing moves under the pointer. */
function layout(nodes: GNode[], links: GLink[]): { nodes: GNode[]; links: GLink[] } {
  const sim = forceSimulation<GNode>(nodes)
    .force("link", forceLink<GNode, GLink>(links).id((d) => d.key).distance(90).strength(0.7))
    .force("charge", forceManyBody().strength(-260))
    .force("collide", forceCollide(34))
    .force("x", forceX(0).strength(0.04))
    .force("y", forceY(0).strength(0.06))
    .stop();
  if (nodes[0]) {
    nodes[0].fx = 0;
    nodes[0].fy = 0;
  }
  for (let i = 0; i < 260; i++) sim.tick();
  return { nodes: [...nodes], links: [...links] };
}

function bounds(nodes: readonly GNode[]): { x: number; y: number; w: number; h: number } {
  if (nodes.length === 0) return { x: -200, y: -120, w: 400, h: 240 };
  const xs = nodes.map((n) => n.x ?? 0);
  const ys = nodes.map((n) => n.y ?? 0);
  const pad = 70;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(320, Math.max(...xs) - x + pad), h: Math.max(220, Math.max(...ys) - y + pad) };
}

/** An object and what its relationships reach, explored by clicking; each step is a governed read as the caller. */
export function Graph(props: GraphProps) {
  const C = useOverride("Graph", GraphBuiltIn);
  return <C {...props} />;
}
