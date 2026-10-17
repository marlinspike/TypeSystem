import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatValue, isTone, type Tone, type ValueFormat } from "../format.js";
import { Frame, Skeleton, Withheld, useOverride, type NodeProps } from "../states.js";

/** Children on a 12-column grid; each spans its `span`, and the grid stacks them on a narrow screen. */
export function Grid(props: { readonly id?: string; readonly columns?: number; readonly span?: number; readonly children?: ReactNode }) {
  return (
    <div className="ts-grid" data-node={props.id} data-span={props.span} data-columns={props.columns ?? 12}>
      {props.children}
    </div>
  );
}

export function Stack(props: { readonly id?: string; readonly direction?: "row" | "column"; readonly span?: number; readonly children?: ReactNode }) {
  return (
    <div className={props.direction === "row" ? "ts-stack ts-row" : "ts-stack"} data-node={props.id} data-span={props.span}>
      {props.children}
    </div>
  );
}

export function Section(props: NodeProps & { readonly description?: string; readonly children?: ReactNode }) {
  return (
    <Frame {...props} kind="section">
      {props.description ? <p className="ts-muted">{props.description}</p> : null}
      <div className="ts-grid">{props.children}</div>
    </Frame>
  );
}

/** WAI-ARIA tabs: arrow keys move between them, Home and End to the first and last. */
export function Tabs(props: { readonly id?: string; readonly span?: number; readonly tabs: readonly { readonly label: string; readonly content: ReactNode }[] }) {
  const [active, setActive] = useState(0);
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number) => {
    const n = (i + props.tabs.length) % props.tabs.length;
    setActive(n);
    refs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") move(active + 1);
    else if (e.key === "ArrowLeft") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(props.tabs.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div className="ts-tabs" data-node={props.id} data-span={props.span}>
      <div role="tablist" className="ts-tablist" onKeyDown={onKey}>
        {props.tabs.map((t, i) => (
          <button
            key={t.label}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${base}-panel-${i}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {props.tabs.map((t, i) => (
        <div key={t.label} role="tabpanel" id={`${base}-panel-${i}`} aria-labelledby={`${base}-tab-${i}`} hidden={i !== active} className="ts-tabpanel">
          {i === active ? t.content : null}
        </div>
      ))}
    </div>
  );
}

export function Text(props: NodeProps & { readonly text: string | undefined; readonly tone?: Tone }) {
  return (
    <p className="ts-text" data-node={props.id} data-span={props.span} data-tone={props.tone}>
      {props.text ?? ""}
    </p>
  );
}

export interface MetricProps extends NodeProps {
  readonly label: string;
  readonly value: unknown;
  readonly format?: ValueFormat;
  readonly tone?: unknown;
  readonly caption?: unknown;
}

function MetricBuiltIn(props: MetricProps) {
  const pending = props.pending ?? [];
  const loading = pending.some((d) => d.status === "loading" && d.value === undefined);
  const failed = pending.find((d) => d.status === "error" && d.value === undefined);
  const tone = isTone(props.tone) ? props.tone : "neutral";
  return (
    <section className="ts-node ts-metric ts-card" data-node={props.id} data-span={props.span} data-tone={tone} data-state={loading ? "loading" : failed ? "error" : "ready"}>
      <div className="ts-metric-label">{props.label}</div>
      <div className="ts-metric-value">
        {loading ? <Skeleton lines={1} /> : failed ? <span className="ts-muted">Unavailable</span> : props.value === undefined ? <Withheld label="Not available to you" /> : formatValue(props.value, props.format)}
      </div>
      {props.caption !== undefined && !loading ? <div className="ts-metric-caption">{formatValue(props.caption, undefined)}</div> : null}
    </section>
  );
}

/** A key figure. Unknown is never shown as 0: it is "not available to you", loading, or unavailable. */
export function Metric(props: MetricProps) {
  const C = useOverride("Metric", MetricBuiltIn);
  return <C {...props} />;
}

export interface ButtonSpec {
  readonly label: string;
  readonly tone?: "primary" | "neutral" | "danger";
  readonly onClick: () => void;
  readonly hidden?: boolean;
}

/** Buttons, each one an interaction. */
export function Actions(props: NodeProps & { readonly buttons: readonly ButtonSpec[] }) {
  const shown = props.buttons.filter((b) => !b.hidden);
  return (
    <div className="ts-actions" data-node={props.id} data-span={props.span}>
      {props.title ? <h2>{props.title}</h2> : null}
      {shown.map((b) => (
        <button key={b.label} type="button" className={`ts-button${b.tone && b.tone !== "neutral" ? ` ts-${b.tone}` : ""}`} onClick={b.onClick}>
          {b.label}
        </button>
      ))}
    </div>
  );
}
