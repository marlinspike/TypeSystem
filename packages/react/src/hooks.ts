import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ActionPreview } from "@typesys/core";
import type { ActionName, Client, ListedActionOf, ModelShape, Page, Row, TypeName } from "@typesys/sdk";
import { Resource, type ResourceState } from "./resource.js";

/** Anything with pages: an SDK query, or one of its includes run on its own. */
export interface PageSource<R> {
  page(cursor?: string): Promise<Page<R>>;
}

export type Loaded<T> = ResourceState<T> & { readonly refresh: () => void };
export type ListState<R> = ResourceState<{ readonly items: readonly R[]; readonly nextCursor?: string }> & {
  readonly refresh: () => void;
  /** Appends the next page; does nothing when there is none or a load is running. */
  readonly loadMore: () => void;
};
export interface ActionState<M extends ModelShape, A extends ActionName<M>> {
  /** Decides the invocation for this caller with nothing executed (ADR-0053). */
  readonly preview: (input: M["actions"][A]["input"]) => Promise<void>;
  readonly invoke: (input: M["actions"][A]["input"]) => Promise<void>;
  readonly previewed: ResourceState<ActionPreview>;
  readonly invoked: ResourceState<M["actions"][A]["output"]>;
  readonly reset: () => void;
}

/**
 * Headless hooks typed by a generated model (ADR-0058):
 * `const { TypeSysProvider, useQuery, useAction } = createTypeSysHooks<AirforceModel>()`.
 * They render nothing and decide nothing: each one calls the SDK client the
 * provider holds, so what a component shows is what the runtime returned for
 * that client's caller, in process or over HTTP.
 */
export function createTypeSysHooks<M extends ModelShape>() {
  const ClientContext = createContext<Client<M> | null>(null);

  function TypeSysProvider(props: { readonly client: Client<M>; readonly children?: ReactNode }) {
    return createElement(ClientContext.Provider, { value: props.client }, props.children);
  }

  function useClient(): Client<M> {
    const client = useContext(ClientContext);
    if (!client) throw new Error("A TypeSys hook was used outside its TypeSysProvider");
    return client;
  }

  /**
   * A resource for this client's caller. A new client (another caller signed
   * in, or signed out) gets a new resource, so nothing the previous caller
   * read is kept visible, not even while loading or after a refusal; a run
   * still in flight for them settles a resource no one reads.
   */
  function useResource<T>(client: Client<M>): [Resource<T>, ResourceState<T>] {
    const [held, setHeld] = useState(() => ({ client, resource: new Resource<T>() }));
    let current = held;
    if (held.client !== client) {
      current = { client, resource: new Resource<T>() };
      setHeld(current);
    }
    const { resource } = current;
    return [resource, useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)];
  }

  /** Loads `load(client)` whenever `deps` change; `null` means nothing to load yet. */
  function useLoad<T>(load: ((client: Client<M>) => Promise<T>) | null, deps: readonly unknown[]): Loaded<T> {
    const client = useClient();
    const [resource, state] = useResource<T>(client);
    const latest = useRef(load);
    latest.current = load;
    const refresh = useCallback(() => {
      const current = latest.current;
      if (current) void resource.run(() => current(client));
      else resource.reset();
    }, [resource, client]);
    useEffect(refresh, [refresh, ...deps]);
    return { ...state, refresh };
  }

  /**
   * A query's first page, and later pages on `loadMore`:
   * `useQuery((af) => af.from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)), [])`.
   */
  function useQuery<R>(build: (client: Client<M>) => PageSource<R> | null, deps: readonly unknown[]): ListState<R> {
    const client = useClient();
    const [resource, state] = useResource<{ items: readonly R[]; nextCursor?: string }>(client);
    const source = useRef<PageSource<R> | null>(null);
    const latest = useRef(build);
    latest.current = build;
    const refresh = useCallback(() => {
      const current = latest.current(client);
      source.current = current;
      if (current) void resource.run(async () => current.page());
      else resource.reset();
    }, [resource, client]);
    const loadMore = useCallback(() => {
      const snapshot = resource.getSnapshot();
      const current = source.current;
      if (!current || snapshot.status !== "success" || snapshot.data.nextCursor === undefined) return;
      const { items, nextCursor } = snapshot.data;
      void resource.run(async () => {
        const next = await current.page(nextCursor);
        return { items: [...items, ...next.items], ...(next.nextCursor === undefined ? {} : { nextCursor: next.nextCursor }) };
      });
    }, [resource]);
    useEffect(refresh, [refresh, ...deps]);
    return { ...state, refresh, loadMore };
  }

  /** One object, with every value this caller may read. */
  function useObject<N extends TypeName<M>>(type: N, id: string | null): Loaded<Row<M, N>> {
    return useLoad(id === null ? null : (c) => c.get(type, id), [type, id]);
  }

  /** The Actions on a Type, or on one object of it, and whether this caller may invoke each. */
  function useActions<N extends TypeName<M>>(type: N, id?: string): Loaded<ListedActionOf<M, N>[]> {
    return useLoad((c) => c.actions(type, id), [type, id]);
  }

  /** One Action: preview what it would do, then invoke it. Each keeps its own state. */
  function useAction<A extends ActionName<M>>(name: A): ActionState<M, A> {
    const client = useClient();
    const [previewing, previewed] = useResource<ActionPreview>(client);
    const [invoking, invoked] = useResource<M["actions"][A]["output"]>(client);
    const handle = client.action(name);
    return {
      preview: (input) => previewing.run(() => handle.preview(input)),
      invoke: (input) => invoking.run(() => handle.invoke(input)),
      previewed,
      invoked,
      reset: () => {
        previewing.reset();
        invoking.reset();
      }
    };
  }

  return { TypeSysProvider, useClient, useLoad, useQuery, useObject, useActions, useAction };
}
