import { useEffect, useMemo, useState } from "react";
import type { ResolvedObject } from "@typesys/core";
import { querySource } from "@typesys/sdk";
import type { StudioApi } from "./api.js";
import { applySuggestion, columnKeys, formatCell, parseQuery, planLines, type QueryDiagnostic } from "./logic.js";
import { ErrorNote } from "./ErrorNote.js";

interface Results {
  readonly items: readonly ResolvedObject[];
  readonly nextCursor?: string;
}

/**
 * A query workbench: the JSON query (ADR-0011) checked against the model as
 * it is typed, its execution plan for this caller (ADR-0054), its results as
 * the runtime returns them to this caller, and the typed SDK code that
 * builds the same query (ADR-0055).
 */
export function QueryView(props: { readonly api: StudioApi; readonly text: string; readonly onText: (text: string) => void }) {
  const { api, text } = props;
  const parsed = useMemo(() => parseQuery(text), [text]);
  const [diagnostics, setDiagnostics] = useState<readonly QueryDiagnostic[]>([]);
  const [plan, setPlan] = useState<readonly string[] | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setPlan(null);
    setResults(null);
    setError(null);
    if (!parsed.ok) {
      setDiagnostics([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api.validate(parsed.query).then(
        (d) => live && setDiagnostics(d),
        (err: unknown) => live && setError(err)
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, parsed]);

  const code = useMemo(() => {
    if (!parsed.ok) return null;
    try {
      return querySource(parsed.query, { client: "client" });
    } catch (err) {
      return `// ${err instanceof Error ? err.message : String(err)}`;
    }
  }, [parsed]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const blocked = !parsed.ok || diagnostics.some((d) => d.severity === "error") || busy;
  const keys = useMemo(() => (results ? columnKeys(results.items, parsed.ok ? (parsed.query.select ?? []) : []) : []), [results, parsed]);

  return (
    <div className="query">
      <div className="split">
        <section>
          <label htmlFor="query-text">Query</label>
          <textarea id="query-text" spellCheck={false} value={text} onChange={(e) => props.onText(e.target.value)} rows={14} />
          {!parsed.ok && <p className="error" role="alert">{parsed.error}</p>}
          <ul className="diagnostics" data-testid="diagnostics">
            {diagnostics.map((d) => (
              <li key={`${d.path}:${d.code}`} className={d.severity}>
                <span className="badge">{d.severity}</span> <code>{d.path || "/"}</code> {d.message}
                {d.suggestion !== undefined && (
                  <button onClick={() => props.onText(applySuggestion(text, d))}>Use “{d.suggestion}”</button>
                )}
              </li>
            ))}
          </ul>
          <div className="row">
            <button
              disabled={blocked}
              onClick={() =>
                void run(async () => {
                  if (parsed.ok) setPlan(planLines(await api.explain(parsed.query)));
                })
              }
            >
              Explain
            </button>
            <button
              className="primary"
              disabled={blocked}
              onClick={() =>
                void run(async () => {
                  if (parsed.ok) setResults(await api.query(parsed.query));
                })
              }
            >
              Run
            </button>
          </div>
        </section>
        <section>
          <label htmlFor="query-code">Typed SDK code</label>
          <pre id="query-code" data-testid="sdk-code">{code ?? ""}</pre>
          {plan && (
            <>
              <h3>Plan for this caller</h3>
              <ol className="plan" data-testid="plan">
                {plan.map((line) => (
                  <li key={line}>{line.replace(/^\d+\. /, "")}</li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
      <ErrorNote error={error} />
      {results && (
        <section data-testid="results">
          <p className="muted">
            {results.items.length} object{results.items.length === 1 ? "" : "s"}. An empty cell is a value this caller may not see, or one not set.
          </p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  {keys.map((k) => (
                    <th key={k}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.items.map((o) => (
                  <tr key={`${o.typeName}:${o.objectId}`}>
                    <td>
                      <code>{o.objectId}</code>
                    </td>
                    {keys.map((k) => (
                      <td key={k}>{formatCell(o.values[k])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {results.nextCursor && parsed.ok && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await api.query({ ...parsed.query, cursor: results.nextCursor! });
                  setResults({ items: [...results.items, ...next.items], ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}) });
                })
              }
            >
              Load more
            </button>
          )}
        </section>
      )}
    </div>
  );
}
