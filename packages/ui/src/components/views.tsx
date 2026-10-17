import { useEffect, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell as PieCell, Legend, Line, LineChart, Pie, PieChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ProvenanceRef } from "@typesys/core";
import type { Data } from "../data.js";
import { formatValue, humanize, isTone, relativeTime, toText, type ValueFormat } from "../format.js";
import { useRuntime } from "../runtime.js";
import { EmptyState, ErrorNote, Frame, Skeleton, Withheld, useOverride, type NodeProps } from "../states.js";
import { Cell, type ColumnSpec } from "./table.js";

const SERIES = ["var(--ts-series-1)", "var(--ts-series-2)", "var(--ts-series-3)", "var(--ts-series-4)", "var(--ts-series-5)"];

/** A dotted path into a value: `key.status` of an aggregate group. */
export function at(v: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);
}

export interface ChartProps extends NodeProps {
  readonly data: Data<readonly unknown[]>;
  readonly chart: "bar" | "line" | "area" | "donut";
  readonly x: string;
  readonly y: readonly string[];
  readonly band?: { readonly from: number | undefined; readonly to: number | undefined; readonly label?: string };
  readonly format?: ValueFormat;
}

function ChartBuiltIn(props: ChartProps) {
  const rows = (props.data.value ?? []).map((r) => ({ x: at(r, props.x), ...Object.fromEntries(props.y.map((y) => [y, at(r, y)])) }));
  const time = rows.length > 0 && rows.every((r) => typeof r.x === "string" && !Number.isNaN(Date.parse(r.x)) && /\d{4}-\d{2}-\d{2}T/.test(r.x));
  const xs = time ? rows.map((r) => ({ ...r, x: Date.parse(r.x as string) })) : rows.map((r) => ({ ...r, x: typeof r.x === "string" ? humanize(r.x) : r.x }));
  const tick = (v: unknown) => (time && typeof v === "number" ? new Date(v).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : String(v));
  const fmt = (v: unknown) => formatValue(v, props.format);
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--ts-grid-line)" vertical={false} />
      <XAxis dataKey="x" type={time ? "number" : "category"} domain={time ? ["dataMin", "dataMax"] : undefined} scale={time ? "time" : "auto"} tickFormatter={tick} stroke="var(--ts-muted)" fontSize={12} />
      <YAxis stroke="var(--ts-muted)" fontSize={12} tickFormatter={(v: number) => fmt(v)} width={56} />
      <Tooltip labelFormatter={(v: unknown) => (time && typeof v === "number" ? new Date(v).toLocaleString() : String(v))} formatter={(v: unknown) => fmt(v)} contentStyle={{ background: "var(--ts-surface)", border: "1px solid var(--ts-border)", borderRadius: 8, color: "var(--ts-text)" }} />
      {props.y.length > 1 ? <Legend formatter={(v: string) => humanize(v.split(".").pop() ?? v)} /> : null}
      {props.band && props.band.from !== undefined && props.band.to !== undefined ? (
        <ReferenceArea y1={props.band.from} y2={props.band.to} fill="var(--ts-good)" fillOpacity={0.08} stroke="var(--ts-good)" strokeOpacity={0.4} strokeDasharray="4 4" label={props.band.label ? { value: props.band.label, position: "insideTopLeft", fill: "var(--ts-muted)", fontSize: 11 } : undefined} ifOverflow="extendDomain" />
      ) : null}
    </>
  );
  let chart;
  if (props.chart === "donut") {
    const y = props.y[0]!;
    chart = (
      <PieChart>
        <Pie data={xs} dataKey={y} nameKey="x" innerRadius="58%" outerRadius="85%" paddingAngle={2} stroke="var(--ts-surface)">
          {xs.map((_, i) => (
            <PieCell key={i} fill={SERIES[i % SERIES.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v: unknown) => fmt(v)} contentStyle={{ background: "var(--ts-surface)", border: "1px solid var(--ts-border)", borderRadius: 8, color: "var(--ts-text)" }} />
        <Legend />
      </PieChart>
    );
  } else if (props.chart === "bar") {
    chart = (
      <BarChart data={xs}>
        {axes}
        {props.y.map((y, i) => (
          <Bar key={y} dataKey={y} fill={SERIES[i % SERIES.length]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        ))}
      </BarChart>
    );
  } else if (props.chart === "area") {
    chart = (
      <AreaChart data={xs}>
        {axes}
        {props.y.map((y, i) => (
          <Area key={y} type="monotone" dataKey={y} stroke={SERIES[i % SERIES.length]} fill={SERIES[i % SERIES.length]} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
        ))}
      </AreaChart>
    );
  } else {
    chart = (
      <LineChart data={xs}>
        {axes}
        {props.y.map((y, i) => (
          <Line key={y} type="monotone" dataKey={y} stroke={SERIES[i % SERIES.length]} strokeWidth={2} dot={false} isAnimationActive={false} />
        ))}
      </LineChart>
    );
  }
  return (
    <Frame {...props} kind="chart" pending={[props.data, ...(props.pending ?? [])]}>
      {rows.length === 0 ? (
        <EmptyState>No data you may see.</EmptyState>
      ) : (
        <div className="ts-chart" role="img" aria-label={`${props.title ?? "Chart"}: ${rows.length} points`}>
          <ResponsiveContainer width="100%" height={260}>
            {chart}
          </ResponsiveContainer>
        </div>
      )}
    </Frame>
  );
}

/** A chart of list data (recharts): bar, line, area or donut, with a shaded band for a permitted range. */
export function Chart(props: ChartProps) {
  const C = useOverride("Chart", ChartBuiltIn);
  return <C {...props} />;
}

export interface DetailProps extends NodeProps {
  readonly data: Data<Readonly<Record<string, unknown>> | null>;
  readonly fields: readonly ColumnSpec[];
  readonly headline?: string;
  /** Offer where each value came from (ADR-0016). */
  readonly provenance?: boolean;
  readonly type?: string;
}

function DetailBuiltIn(props: DetailProps) {
  const row = props.data.value;
  const [open, setOpen] = useState<string | undefined>();
  return (
    <Frame {...props} kind="detail" pending={[props.data, ...(props.pending ?? [])]} title={props.headline && row ? (toText(row[props.headline]) ?? props.title ?? "") : props.title}>
      {row === null || row === undefined ? (
        <EmptyState>Nothing selected.</EmptyState>
      ) : (
        <dl className="ts-kv ts-detail-fields">
          {props.fields.map((f) => (
            <div key={f.field}>
              <dt>{f.label ?? humanize(f.field)}</dt>
              <dd>
                <Cell row={row} column={f} />
                {props.provenance && props.type && Object.hasOwn(row, f.field) ? (
                  <button type="button" className="ts-link ts-prov-toggle" aria-expanded={open === f.field} onClick={() => setOpen(open === f.field ? undefined : f.field)} title="Where this value came from">
                    source
                  </button>
                ) : null}
                {open === f.field && props.type ? <ProvenanceList type={props.type} id={String(row.$id)} property={f.field} /> : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Frame>
  );
}

/** One object's values; a value the caller is not returned is shown as withheld, with its source on request. */
export function Detail(props: DetailProps) {
  const C = useOverride("Detail", DetailBuiltIn);
  return <C {...props} />;
}

/** Where one value came from, read through the runtime as the caller (ADR-0022). */
export function ProvenanceList(props: { readonly type: string; readonly id: string; readonly property: string }) {
  const { client } = useRuntime();
  const [state, setState] = useState<{ refs?: ProvenanceRef[]; error?: Error }>({});
  useEffect(() => {
    let live = true;
    setState({});
    client.provenance(props.type as never, props.id, props.property as never).then(
      (refs) => live && setState({ refs }),
      (error: Error) => live && setState({ error })
    );
    return () => {
      live = false;
    };
  }, [client, props.type, props.id, props.property]);
  if (state.error) return <ErrorNote error={state.error} />;
  if (!state.refs) return <Skeleton lines={1} />;
  if (state.refs.length === 0) return <EmptyState>No provenance recorded.</EmptyState>;
  return (
    <ul className="ts-provenance">
      {state.refs.map((r, i) => (
        <li key={i}>
          <span className="ts-prov-path">{r.propertyPath}</span>
          <span className="ts-badge" data-tone="info">
            {r.source.system}
          </span>
          <span className="ts-muted">
            {r.source.recordId ? `record ${r.source.recordId}` : r.source.dataSourceId}
            {r.source.field ? ` · ${r.source.field}` : ""} · {relativeTime(r.observedAt ?? r.retrievedAt)}
            {r.confidence !== undefined ? ` · ${Math.round(r.confidence * 100)}% confidence` : ""}
            {r.classification ? ` · ${r.classification}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Provenance(props: NodeProps & { readonly data: Data<Readonly<Record<string, unknown>> | null>; readonly type: string; readonly property: string }) {
  const row = props.data.value;
  return (
    <Frame {...props} kind="provenance" pending={[props.data]} title={props.title ?? `Where ${humanize(props.property).toLowerCase()} came from`}>
      {row ? Object.hasOwn(row, props.property) ? <ProvenanceList type={props.type} id={String(row.$id)} property={props.property} /> : <Withheld /> : <EmptyState>Nothing selected.</EmptyState>}
    </Frame>
  );
}

export interface TimelineItem {
  readonly key: string;
  readonly time: string | undefined;
  readonly label: string | undefined;
  readonly detail?: string | undefined;
  readonly tone?: unknown;
}

/** Events in time order, newest first. */
export function Timeline(props: NodeProps & { readonly data: Data<readonly unknown[]>; readonly items: readonly TimelineItem[] }) {
  const items = [...props.items].sort((a, b) => Date.parse(b.time ?? "") - Date.parse(a.time ?? ""));
  return (
    <Frame {...props} kind="timeline" pending={[props.data, ...(props.pending ?? [])]}>
      {items.length === 0 ? (
        <EmptyState>No events you may see.</EmptyState>
      ) : (
        <ol className="ts-timeline">
          {items.map((it) => (
            <li key={it.key} data-tone={isTone(it.tone) ? it.tone : "neutral"}>
              <time dateTime={it.time}>{it.time ? formatValue(it.time, "date-time") : <Withheld />}</time>
              <div className="ts-tl-label">{it.label ?? <Withheld />}</div>
              {it.detail ? <div className="ts-muted">{it.detail}</div> : null}
            </li>
          ))}
        </ol>
      )}
    </Frame>
  );
}
