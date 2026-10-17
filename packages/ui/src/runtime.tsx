import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient, httpCall, httpTransport, httpWorkflows, type Client, type ModelShape, type WorkflowsClient } from "@typesys/sdk";

/** The signed-in caller, as the API's `/me` describes them. Presentation only: the runtime decides every value. */
export interface Me {
  readonly subjectId: string;
  readonly roles: readonly string[];
}

/** A message the person is shown for a moment: what an Action or a run did, or why it was refused. */
export interface Notice {
  readonly id: number;
  readonly tone: "good" | "warn" | "bad" | "info";
  readonly text: string;
}

/**
 * Who changed what, so data that read it read again (ADR-0082): an Action
 * or a run publishes the Types it may have changed, and every read of one
 * of them refreshes. It is how the interface stays current without an
 * event feed the API does not have.
 */
export class Invalidation {
  private readonly listeners = new Set<{ types: ReadonlySet<string>; fn: () => void }>();

  subscribe(types: readonly string[], fn: () => void): () => void {
    const entry = { types: new Set(types), fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  publish(types: readonly string[]): void {
    for (const l of [...this.listeners]) if (types.some((t) => l.types.has(t))) l.fn();
  }
}

export interface AppRuntime {
  readonly client: Client<ModelShape>;
  readonly workflows: WorkflowsClient;
  readonly token: string;
  readonly me: Me | undefined;
  readonly signIn: (token: string) => void;
  readonly invalidation: Invalidation;
  readonly notices: readonly Notice[];
  readonly notify: (tone: Notice["tone"], text: string) => void;
  readonly dismiss: (id: number) => void;
  /** Application state, shared by every page. */
  readonly state: Readonly<Record<string, unknown>>;
  readonly setState: (name: string, value: unknown) => void;
}

const RuntimeContext = createContext<AppRuntime | null>(null);

export function useRuntime(): AppRuntime {
  const r = useContext(RuntimeContext);
  if (!r) throw new Error("A TypeSystem component was used outside its <AppRuntimeProvider>");
  return r;
}

/** The governed client, typed by the application's generated model. */
export function useClient<M extends ModelShape>(): Client<M> {
  return useRuntime().client as unknown as Client<M>;
}

const TOKEN_KEY = "typesys.token";

function storedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Holds the caller's token and everything bound to it: the SDK client and
 * workflow client over `/api`, who `/me` says they are, and the application
 * state. Signing in as someone else replaces the client, so nothing read for
 * the previous caller is kept on screen.
 */
export function AppRuntimeProvider(props: { readonly baseUrl?: string; readonly initialState?: Readonly<Record<string, unknown>>; readonly children?: ReactNode }) {
  const baseUrl = props.baseUrl ?? "/api";
  const [token, setToken] = useState(storedToken);
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [state, setStateMap] = useState<Readonly<Record<string, unknown>>>(props.initialState ?? {});
  const invalidation = useRef(new Invalidation()).current;
  const next = useRef(1);

  const client = useMemo(() => createClient<ModelShape>(httpTransport({ baseUrl, ...(token ? { token } : {}) })), [baseUrl, token]);
  const workflows = useMemo(() => httpWorkflows({ baseUrl, ...(token ? { token } : {}) }), [baseUrl, token]);

  useEffect(() => {
    let live = true;
    setMe(undefined);
    httpCall({ baseUrl, ...(token ? { token } : {}) })("GET", "/me").then(
      (m) => live && setMe(m as Me),
      () => live && setMe(undefined)
    );
    return () => {
      live = false;
    };
  }, [baseUrl, token]);

  const signIn = useCallback(
    (t: string) => {
      try {
        if (t) sessionStorage.setItem(TOKEN_KEY, t);
        else sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        // Storage refused (a private window): the token lasts as long as the page.
      }
      setToken(t);
      // State chosen as one caller (a selection, a draft) is not carried to the next.
      setStateMap(props.initialState ?? {});
    },
    [props.initialState]
  );
  const dismiss = useCallback((id: number) => setNotices((ns) => ns.filter((n) => n.id !== id)), []);
  const notify = useCallback(
    (tone: Notice["tone"], text: string) => {
      const id = next.current++;
      setNotices((ns) => [...ns.slice(-3), { id, tone, text }]);
      setTimeout(() => dismiss(id), tone === "bad" ? 9000 : 5000);
    },
    [dismiss]
  );
  const setState = useCallback((name: string, value: unknown) => setStateMap((s) => ({ ...s, [name]: value })), []);

  const runtime = useMemo<AppRuntime>(
    () => ({ client, workflows, token, me, signIn, invalidation, notices, notify, dismiss, state, setState }),
    [client, workflows, token, me, signIn, invalidation, notices, notify, dismiss, state, setState]
  );
  return <RuntimeContext.Provider value={runtime}>{props.children}</RuntimeContext.Provider>;
}
