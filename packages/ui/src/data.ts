import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { UnknownValueError } from "@typesys/app";
import { Resource } from "@typesys/react";
import type { Client, ModelShape } from "@typesys/sdk";
import { useRuntime } from "./runtime.js";

/**
 * Where one piece of an application's data is (ADR-0082):
 *
 * - `waiting`: a value the read needs is unknown (nothing selected yet).
 * - `loading`: being read; `value` is the previous answer, if any, kept on
 *   screen and marked `stale`.
 * - `ready`: the runtime's answer for this caller.
 * - `error`: the read failed; `error` says why (a refusal is an `ApiError`
 *   with status 403), and `value` is the previous answer, if any.
 *
 * A component shows each state as itself: a skeleton, an empty state, an
 * error, never a blank that could be mistaken for "nothing there".
 */
export interface Data<T> {
  readonly status: "waiting" | "loading" | "ready" | "error";
  readonly value: T | undefined;
  readonly error?: Error;
  readonly stale: boolean;
  readonly refresh: () => void;
}

export interface ReadOptions {
  /** The Types it reads: an Action or run that may change one reads it again. */
  readonly types?: readonly string[];
  /** Read again this often, for data that change without the application changing them. */
  readonly everyMs?: number;
}

/**
 * One governed read, as the signed-in caller, whenever `deps` change, after
 * an Action or run changes a Type in `types`, and every `everyMs`. `load`
 * throws `UnknownValueError` (from `need`) while a value it needs is
 * unknown, which is `waiting`, not an error.
 */
export function useRead<T>(load: (client: Client<ModelShape>) => Promise<T>, deps: readonly unknown[], opts: ReadOptions = {}): Data<T> {
  const { client, invalidation } = useRuntime();
  const resource = useMemo(() => new Resource<T>(), [client]);
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  const latest = useRef(load);
  latest.current = load;
  const refresh = useCallback(() => void resource.run(() => latest.current(client)), [resource, client]);
  const key = JSON.stringify(deps);
  useEffect(refresh, [refresh, key]);
  const types = (opts.types ?? []).join(",");
  useEffect(() => (types ? invalidation.subscribe(types.split(","), refresh) : undefined), [invalidation, types, refresh]);
  useEffect(() => {
    if (!opts.everyMs) return;
    const timer = setInterval(() => {
      // A page in the background does not poll.
      if (typeof document === "undefined" || document.visibilityState === "visible") refresh();
    }, opts.everyMs);
    return () => clearInterval(timer);
  }, [opts.everyMs, refresh]);
  return toData(state, refresh);
}

function toData<T>(state: ReturnType<Resource<T>["getSnapshot"]>, refresh: () => void): Data<T> {
  switch (state.status) {
    case "idle":
      return { status: "loading", value: undefined, stale: false, refresh };
    case "loading":
      return { status: "loading", value: state.data, stale: state.data !== undefined, refresh };
    case "success":
      return { status: "ready", value: state.data, stale: false, refresh };
    case "error":
      if (state.error instanceof UnknownValueError || state.error.name === "UnknownValueError") return { status: "waiting", value: undefined, stale: false, refresh };
      return { status: "error", value: state.data, error: state.error, stale: state.data !== undefined, refresh };
  }
}

/**
 * A value computed on the client from other data: ready when they all are,
 * loading while any is, an error when any failed. It is computed whatever
 * their state, since the operators treat what is not there yet as unknown.
 */
export function useDerived<T>(compute: () => T, from: readonly Data<unknown>[]): Data<T> {
  // Computed from a read that has no value yet (loading, failed, waiting), the result is not known either:
  // a selection over nothing would be an empty list, and a figure over it a confident 0.
  const value = from.some((d) => d.status !== "ready" && d.value === undefined) ? (undefined as T) : compute();
  const status = combine(from);
  const refresh = useCallback(() => from.forEach((d) => d.refresh()), [from]);
  const error = from.find((d) => d.status === "error")?.error;
  return { status, value, ...(error ? { error } : {}), stale: from.some((d) => d.stale), refresh };
}

/** The state of several data together: an error if any failed, then waiting, then loading, else ready. */
export function combine(from: readonly Data<unknown>[]): Data<unknown>["status"] {
  if (from.some((d) => d.status === "error")) return "error";
  if (from.some((d) => d.status === "waiting")) return "waiting";
  if (from.some((d) => d.status === "loading")) return "loading";
  return "ready";
}

/** Data that are already known: a constant, or a value computed from state alone. */
export function known<T>(value: T): Data<T> {
  return { status: "ready", value, stale: false, refresh: () => undefined };
}

/**
 * `useRead` with the client typed by an application's generated model, so
 * a generated page's reads are checked by tsc against the same model the
 * compiler checked them against.
 */
export function typedRead<M extends ModelShape>(): <T>(load: (client: Client<M>) => Promise<T>, deps: readonly unknown[], opts?: ReadOptions) => Data<T> {
  return useRead as unknown as <T>(load: (client: Client<M>) => Promise<T>, deps: readonly unknown[], opts?: ReadOptions) => Data<T>;
}

/**
 * A page's state: the application's (shared by every page, kept in the
 * runtime) and the page's own (kept while the page is shown), read as one
 * value and set by name.
 */
export function usePageState<S extends object>(local: Readonly<Record<string, unknown>>): [S, (name: string, value: unknown) => void] {
  const runtime = useRuntime();
  const [mine, setMine] = useState<Readonly<Record<string, unknown>>>(local);
  const set = useCallback(
    (name: string, value: unknown) => {
      if (Object.hasOwn(local, name)) setMine((s) => ({ ...s, [name]: value }));
      else runtime.setState(name, value);
    },
    // The defaults are a module constant; the runtime's setter is stable.
    [runtime.setState]
  );
  const state = useMemo(() => ({ ...runtime.state, ...mine }) as S, [runtime.state, mine]);
  return [state, set];
}
