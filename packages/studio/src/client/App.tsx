import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelDescription } from "@typesys/core";
import { loadConfig, studioApi, type Me, type StudioConfig } from "./api.js";
import { TOKEN_KEY, starterQuery } from "./logic.js";
import { ModelView } from "./ModelView.js";
import { QueryView } from "./QueryView.js";
import { ActionsView } from "./ActionsView.js";
import { ErrorNote } from "./ErrorNote.js";

type Tab = "model" | "query" | "actions";

function storedToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeToken(token: string | undefined): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token lives only as long as the page.
  }
}

/**
 * TypeS Studio (ADR-0061). It signs in with a bearer token and then sees the
 * model, queries and Actions exactly as the API answers that caller: change
 * the token and the same screens show what someone else may see.
 */
export function App() {
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [token, setToken] = useState<string | undefined>(storedToken);
  const [draftToken, setDraftToken] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [model, setModel] = useState<ModelDescription | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>("model");
  const [query, setQuery] = useState(starterQuery("airforce.Aircraft"));
  const [action, setAction] = useState<string | null>(null);

  const api = useMemo(() => studioApi(token), [token]);

  useEffect(() => {
    loadConfig().then(setConfig, setError);
  }, []);

  useEffect(() => {
    let live = true;
    setMe(null);
    setModel(null);
    setError(null);
    Promise.all([api.me(), api.model()]).then(
      ([who, m]) => {
        if (!live) return;
        setMe(who);
        setModel(m);
        if (m.types[0] && !m.types.some((t) => t.name === "airforce.Aircraft")) setQuery(starterQuery(m.types[0].name));
      },
      (err: unknown) => live && setError(err)
    );
    return () => {
      live = false;
    };
  }, [api]);

  const signIn = useCallback((next: string | undefined) => {
    storeToken(next);
    setToken(next);
    setDraftToken("");
  }, []);

  const openQuery = useCallback((type: string) => {
    setQuery(starterQuery(type));
    setTab("query");
  }, []);
  const openAction = useCallback((name: string) => {
    setAction(name);
    setTab("actions");
  }, []);

  return (
    <div className="studio">
      <header>
        <h1>{config?.title ?? "TypeS Studio"}</h1>
        <div className="who" aria-live="polite">
          {me ? (
            <>
              Signed in as <strong data-testid="subject">{me.subjectId}</strong>
              {me.roles.length > 0 && <span className="muted"> · {me.roles.join(", ")}</span>}
              {me.clearance && <span className="badge">{me.clearance}</span>}
            </>
          ) : (
            <span className="muted">Signing in…</span>
          )}
        </div>
        <form
          className="signin"
          onSubmit={(e) => {
            e.preventDefault();
            signIn(draftToken.trim() || undefined);
          }}
        >
          {config?.demo?.map((d) => (
            <button key={d.label} type="button" className={token === d.token ? "on" : ""} onClick={() => signIn(d.token)}>
              {d.label}
            </button>
          ))}
          <button type="button" className={token === undefined ? "on" : ""} onClick={() => signIn(undefined)}>
            Anonymous
          </button>
          <input type="password" placeholder="Bearer token" aria-label="Bearer token" value={draftToken} onChange={(e) => setDraftToken(e.target.value)} autoComplete="off" />
          <button type="submit">Sign in</button>
        </form>
      </header>
      <nav role="tablist">
        {(["model", "query", "actions"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "model" ? "Model" : t === "query" ? "Query" : "Actions"}
          </button>
        ))}
      </nav>
      <main>
        <ErrorNote error={error} />
        {model && tab === "model" && <ModelView api={api} model={model} onQuery={openQuery} onAction={openAction} />}
        {model && tab === "query" && <QueryView api={api} text={query} onText={setQuery} />}
        {model && tab === "actions" && <ActionsView api={api} model={model} selected={action} onSelect={setAction} />}
      </main>
    </div>
  );
}
