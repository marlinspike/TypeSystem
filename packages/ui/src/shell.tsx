import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmHost } from "./effects.js";
import { humanize } from "./format.js";
import { PageLink, Router, useRouter, type PageRoute } from "./router.js";
import { AppRuntimeProvider, useRuntime } from "./runtime.js";
import { OverridesProvider, type Overrides } from "./states.js";

/** How an application looks, kept apart from what it does (ADR-0082). */
export interface DesignOptions {
  /** `meridian` (a dark operations console) or `ledger` (a light editorial report). */
  readonly system: string;
  /** CSS custom properties over the system's (`--ts-accent`, `--ts-radius`). */
  readonly tokens?: Readonly<Record<string, string>>;
  readonly density?: "comfortable" | "compact";
  readonly brand?: { readonly name: string; readonly mark?: string };
  /** Components in place of the built-in ones, by name: a design system's own Metric, say. */
  readonly overrides?: Overrides;
}

export interface AppOptions {
  readonly title: string;
  readonly pages: readonly PageRoute[];
  readonly design: DesignOptions;
  readonly initialState?: Readonly<Record<string, unknown>>;
  /**
   * Demonstration sign-in: a caller name → token, offered as buttons. Only
   * for demo tokens an application's spec already publishes; a real
   * deployment signs in through its identity provider.
   */
  readonly presets?: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
}

function SignIn(props: { readonly presets?: Readonly<Record<string, string>> }) {
  const { token, signIn, me } = useRuntime();
  const [draft, setDraft] = useState("");
  const current = Object.entries(props.presets ?? {}).find(([, t]) => t === token)?.[0];
  // `?as=<preset>` signs in as a demonstration preset, so a guide can link to a page as a named person; never a token in a URL.
  useEffect(() => {
    if (!props.presets || typeof location === "undefined") return;
    const url = new URL(location.href);
    const as = url.searchParams.get("as");
    const preset = as ? Object.entries(props.presets).find(([name]) => name.toLowerCase() === as.toLowerCase()) : undefined;
    if (!as) return;
    if (preset && preset[1] !== token) signIn(preset[1]);
    url.searchParams.delete("as");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }, []); // Once, on arrival.
  return (
    <div className="ts-signin">
      <span className="ts-me" data-signed-in={me ? "true" : "false"}>
        {me ? (
          <>
            <span className="ts-avatar" aria-hidden="true">
              {(current ?? me.subjectId).charAt(0).toUpperCase()}
            </span>
            <span>
              {current ? humanize(current) : me.subjectId}
              <span className="ts-muted"> {me.roles.join(", ") || "no roles"}</span>
            </span>
          </>
        ) : (
          <span className="ts-muted">Not signed in</span>
        )}
      </span>
      {props.presets ? (
        <span className="ts-presets" role="group" aria-label="Sign in as">
          {Object.entries(props.presets).map(([name, t]) => (
            <button key={name} type="button" className="ts-chip" aria-pressed={token === t} onClick={() => signIn(t)}>
              {humanize(name)}
            </button>
          ))}
        </span>
      ) : (
        <form
          className="ts-token"
          onSubmit={(e) => {
            e.preventDefault();
            signIn(draft.trim());
            setDraft("");
          }}
        >
          <input className="ts-input" type="password" autoComplete="off" placeholder="Token" aria-label="Token" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="ts-button">
            Sign in
          </button>
          {token ? (
            <button type="button" className="ts-link" onClick={() => signIn("")}>
              Sign out
            </button>
          ) : null}
        </form>
      )}
    </div>
  );
}

function Notices() {
  const { notices, dismiss } = useRuntime();
  return (
    <div className="ts-toasts" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className="ts-toast" data-tone={n.tone}>
          <span>{n.text}</span>
          <button type="button" className="ts-link" aria-label="Dismiss" onClick={() => dismiss(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function Current() {
  const { page, params } = useRouter();
  const { token } = useRuntime();
  useEffect(() => {
    if (page) document.title = page.title;
  }, [page]);
  if (!page)
    return (
      <div className="ts-card ts-notfound">
        <h1>Not found</h1>
        <PageLink page="">Back to the start</PageLink>
      </div>
    );
  const C = page.component;
  // A new caller gets a new page: nothing the previous one read stays mounted.
  return <C key={`${page.name}:${token}:${JSON.stringify(params)}`} params={params} />;
}

/** The application's frame: brand, navigation, who is signed in, the page, notices and the confirmation dialog. */
export function AppShell(props: AppOptions & { readonly children?: ReactNode }) {
  const nav = props.pages.filter((p) => p.nav);
  const tokens = Object.fromEntries(Object.entries(props.design.tokens ?? {}).map(([k, v]) => [k.startsWith("--") ? k : `--ts-${k}`, v]));
  return (
    <AppRuntimeProvider {...(props.baseUrl ? { baseUrl: props.baseUrl } : {})} {...(props.initialState ? { initialState: props.initialState } : {})}>
      <OverridesProvider overrides={props.design.overrides ?? {}}>
        <Router pages={props.pages}>
          <ConfirmHost>
            <div className="ts-app" data-design={props.design.system} data-density={props.design.density ?? "comfortable"} style={tokens}>
              <header className="ts-topbar">
                <div className="ts-brand">
                  <span className="ts-mark" aria-hidden="true">
                    {props.design.brand?.mark ?? "◆"}
                  </span>
                  <span>{props.design.brand?.name ?? props.title}</span>
                </div>
                <nav className="ts-nav" aria-label="Pages">
                  {nav.map((p) => (
                    <PageLink key={p.name} page={p.name} className="ts-nav-link">
                      {p.title}
                    </PageLink>
                  ))}
                </nav>
                <SignIn {...(props.presets ? { presets: props.presets } : {})} />
              </header>
              <main className="ts-main">
                <Current />
              </main>
              <Notices />
            </div>
          </ConfirmHost>
        </Router>
      </OverridesProvider>
    </AppRuntimeProvider>
  );
}

/** Mounts the application at `#root`. */
export function mountApp(options: AppOptions): void {
  const el = document.getElementById("root");
  if (!el) throw new Error("The page has no #root to mount the application in");
  createRoot(el).render(<AppShell {...options} />);
}

/** The page's own title and description, above its layout. */
export function PageHeader(props: { readonly title: string; readonly description?: string; readonly children?: ReactNode }) {
  return (
    <div className="ts-page-head">
      <div>
        <h1>{props.title}</h1>
        {props.description ? <p className="ts-muted">{props.description}</p> : null}
      </div>
      {props.children}
    </div>
  );
}
