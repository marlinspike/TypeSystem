import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { ApiError } from "@typesys/sdk";
import { combine, type Data } from "./data.js";

/**
 * What every node shares (ADR-0082): a stable `id` that screen checks and
 * tests find it by (`data-node`), a title, the grid span, and the data it
 * shows, whose state the frame renders the same way everywhere.
 */
export interface NodeProps {
  readonly id?: string;
  readonly title?: string;
  readonly span?: number;
  /** Data the node shows: until each is ready, the frame shows their state instead of the node. */
  readonly pending?: readonly Data<unknown>[];
  /** What to say while a value it needs is unknown (`waiting`). */
  readonly waiting?: string;
  readonly className?: string;
}

/** A refusal or failure, in the words a person can act on. Never the server's internals: the API sends none. */
export function errorText(error: Error | undefined): string {
  if (error instanceof ApiError || error?.name === "ApiError") {
    const e = error as ApiError;
    if (e.status === 401) return "Sign in to see this.";
    if (e.status === 403) return "You are not permitted to see this.";
    if (e.status === 404) return "Not found, or not visible to you.";
    if (e.status === 429) return "Too many requests; try again shortly.";
    if (e.status >= 500) return "The service could not answer. Try again.";
    return e.message;
  }
  return error?.message ?? "Something went wrong.";
}

export function Skeleton(props: { readonly lines?: number }) {
  return (
    <div className="ts-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: props.lines ?? 3 }, (_, i) => (
        <span key={i} className="ts-skeleton-line" />
      ))}
    </div>
  );
}

export function EmptyState(props: { readonly children?: ReactNode }) {
  return <div className="ts-empty">{props.children ?? "Nothing to show."}</div>;
}

export function ErrorNote(props: { readonly error: Error | undefined; readonly retry?: () => void }) {
  const refused = props.error instanceof ApiError && (props.error.status === 403 || props.error.status === 401);
  return (
    <div className={refused ? "ts-error ts-refused" : "ts-error"} role="alert">
      <span>{errorText(props.error)}</span>
      {props.retry && !refused ? (
        <button type="button" className="ts-link" onClick={props.retry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** A value the runtime did not return to this caller: shown as withheld, never as empty. */
export function Withheld(props: { readonly label?: string }) {
  return (
    <span className="ts-withheld" title="Withheld from you by policy or classification">
      <span aria-hidden="true">◌</span> {props.label ?? "Withheld"}
    </span>
  );
}

/** Parts of an object whose source failed to answer (ADR-0072). */
export function Unavailable(props: { readonly parts: readonly { readonly path: string; readonly reason: string; readonly message?: string }[] }) {
  if (props.parts.length === 0) return null;
  return (
    <div className="ts-partial" role="status">
      <strong>Partial data.</strong> {props.parts.map((p) => `${p.path} ${p.reason === "timeout" ? "timed out" : p.reason === "refused-by-source" ? "was refused by its source" : "is unavailable"}`).join("; ")}.
    </div>
  );
}

/** Every `$unavailable` part in a value: one row's, or each row's of a list. */
export function unavailableIn(value: unknown): { path: string; reason: string; message?: string }[] {
  const of = (v: unknown) => (v && typeof v === "object" && Array.isArray((v as { $unavailable?: unknown }).$unavailable) ? ((v as { $unavailable: { path: string; reason: string; message?: string }[] }).$unavailable) : []);
  const parts = Array.isArray(value) ? value.flatMap(of) : of(value);
  const seen = new Set<string>();
  return parts.filter((p) => !seen.has(`${p.path}:${p.reason}`) && seen.add(`${p.path}:${p.reason}`));
}

/**
 * The card every data node sits in: its title, and its data's state when
 * that is not ready (a skeleton, a waiting line, an error), or the node
 * with a quiet marker while a newer read runs.
 */
export function Frame(props: NodeProps & { readonly kind: string; readonly children?: ReactNode; readonly actions?: ReactNode; readonly bare?: boolean; readonly rowCount?: number }) {
  const pending = props.pending ?? [];
  const status = combine(pending);
  const firstError = pending.find((d) => d.status === "error");
  const hasValue = pending.every((d) => d.value !== undefined);
  const stale = pending.some((d) => d.stale || (d.status === "loading" && d.value !== undefined));
  const partial = unavailableIn(pending.map((d) => d.value).flat());
  let body: ReactNode;
  if (status === "error" && !hasValue) body = <ErrorNote error={firstError?.error} retry={firstError?.refresh} />;
  else if (status === "waiting") body = <EmptyState>{props.waiting ?? "Waiting for a selection."}</EmptyState>;
  else if (status === "loading" && !hasValue) body = <Skeleton />;
  else body = props.children;
  const span = props.span ? Math.max(1, Math.min(12, Math.round(props.span))) : undefined;
  return (
    <section
      className={["ts-node", `ts-node-${props.kind}`, props.bare ? "ts-bare" : "ts-card", props.className].filter(Boolean).join(" ")}
      data-node={props.id}
      data-state={status}
      data-span={span}
      // How many rows the node was given, whatever page of them it shows: what a screen check counts.
      data-rows={props.rowCount}
      aria-busy={status === "loading" ? true : undefined}
      aria-labelledby={props.title && props.id ? `${props.id}-title` : undefined}
    >
      {props.title || props.actions ? (
        <header className="ts-node-head">
          {props.title ? <h2 id={props.id ? `${props.id}-title` : undefined}>{props.title}</h2> : <span />}
          <span className="ts-node-tools">
            {stale ? <span className="ts-stale" aria-label="Refreshing" /> : null}
            {props.actions}
          </span>
        </header>
      ) : null}
      {partial.length && status !== "error" ? <Unavailable parts={partial} /> : null}
      {status === "error" && hasValue ? <ErrorNote error={firstError?.error} retry={firstError?.refresh} /> : null}
      {body}
    </section>
  );
}

/** Components a design system or an application puts in place of the built-in ones, by name (ADR-0082). */
export type Overrides = Readonly<Partial<Record<string, ComponentType<never>>>>;

const OverrideContext = createContext<Overrides>({});

export function OverridesProvider(props: { readonly overrides: Overrides; readonly children?: ReactNode }) {
  return <OverrideContext.Provider value={props.overrides}>{props.children}</OverrideContext.Provider>;
}

/** The component to render for `name`: an override when one is given, else the built-in. */
export function useOverride<P>(name: string, builtIn: ComponentType<P>): ComponentType<P> {
  const o = useContext(OverrideContext)[name];
  return (o as ComponentType<P> | undefined) ?? builtIn;
}
