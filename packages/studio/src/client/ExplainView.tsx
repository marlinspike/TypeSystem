import { useEffect, useState } from "react";
import type { ExplainQuestion, Explanation, Finding, ModelDescription } from "@typesys/core";
import type { StudioApi, WorkflowExplanation } from "./api.js";
import { ErrorNote } from "./ErrorNote.js";

export type ExplainSeed = { readonly kind: "read" | "relationship"; readonly type: string; readonly relationship?: string } | { readonly kind: "invoke"; readonly action: string } | { readonly kind: "workflow"; readonly workflow: string };
type Kind = "read" | "relationship" | "invoke" | "query" | "workflow";

const OUTCOME_CLASS: Record<string, string> = { returned: "good", allowed: "good", withheld: "warn", refused: "error", "not-found": "warn", unavailable: "error", invalid: "error", dangling: "warn", truncated: "warn", "no-value": "" };

function Findings({ findings }: { readonly findings: readonly Finding[] }) {
  return (
    <div className="scroll">
      <table data-testid="findings">
        <thead>
          <tr>
            <th>About</th>
            <th>Outcome</th>
            <th>How known</th>
            <th>Decided by</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f, i) => (
            <tr key={i}>
              <td>
                <code>{f.member ?? f.about}</code>
              </td>
              <td>
                <span className={`badge ${OUTCOME_CLASS[f.outcome] ?? ""}`}>{f.outcome}</span>
              </td>
              <td>
                <span className="badge">{f.basis}</span>
              </td>
              <td>
                {f.control && <span className="badge">{f.control}</span>}
                {f.policy && <code>{f.policy}</code>}
                {f.rule && <div className="muted">{f.rule}</div>}
                {f.markings && f.markings.length > 0 && <div>{f.markings.map((m) => <span key={m} className="badge marking">{m}</span>)}</div>}
                {f.source && <div className="muted">source {f.source}</div>}
              </td>
              <td>
                {f.reason}
                {f.inputs && f.inputs.length > 0 && <div className="muted">inputs: {f.inputs.join(", ")}</div>}
                {f.remedy && <div className="muted">To change it: {f.remedy}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Why a read, relationship, Action, query or workflow is allowed, partly
 * answered, refused or unavailable (ADR-0089): the runtime's own decisions
 * replayed for the signed-in caller, or, for someone who may inspect, for
 * any subject the deployment's directory names. A caller who may not
 * inspect is told only what a refusal already tells them.
 */
export function ExplainView(props: { readonly api: StudioApi; readonly model: ModelDescription; readonly seed: ExplainSeed | null }) {
  const { api, model, seed } = props;
  const firstType = model.types[0]?.name ?? "";
  const [kind, setKind] = useState<Kind>(seed?.kind ?? "read");
  const [type, setType] = useState(seed && "type" in seed ? seed.type : firstType);
  const [id, setId] = useState("");
  const [relationship, setRelationship] = useState(seed && "relationship" in seed ? (seed.relationship ?? "") : "");
  const [action, setAction] = useState(seed?.kind === "invoke" ? seed.action : (model.actions[0]?.name ?? ""));
  const [input, setInput] = useState("{}");
  const [query, setQuery] = useState(JSON.stringify({ type: firstType, limit: 5 }, null, 2));
  const [workflow, setWorkflow] = useState(seed?.kind === "workflow" ? seed.workflow : "");
  const [workflows, setWorkflows] = useState<readonly string[]>([]);
  const [subjects, setSubjects] = useState<readonly { subjectId: string; label?: string }[] | null>(null);
  const [as, setAs] = useState("");
  const [result, setResult] = useState<Explanation | WorkflowExplanation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // Only an inspector is given the directory, so it is asked for only when the graph says they may inspect.
    api.graph("overview").then(
      (g) => {
        if (!live) return;
        setWorkflows(g.nodes.filter((n) => n.kind === "workflow" && !n.unresolved).map((n) => n.label));
        if (g.structure === "inspection")
          api.subjects().then(
            (s) => live && setSubjects(s),
            () => live && setSubjects(null)
          );
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    if (!workflow && workflows[0]) setWorkflow(workflows[0]);
  }, [workflow, workflows]);

  const typeDesc = model.types.find((t) => t.name === type);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (kind === "workflow") {
        setResult(await api.explainWorkflow(workflow, as || undefined));
        return;
      }
      const question: ExplainQuestion =
        kind === "read"
          ? { kind, type, id }
          : kind === "relationship"
            ? { kind, type, id, relationship }
            : kind === "invoke"
              ? { kind, action, input: JSON.parse(input) as unknown }
              : { kind, query: JSON.parse(query) as never };
      setResult(await api.explainAccess(question, as || undefined));
    } catch (err) {
      setError(err instanceof SyntaxError ? new Error(`Not valid JSON: ${err.message}`) : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="split">
      <aside>
        <div className="field">
          <label htmlFor="explain-kind">Explain</label>
          <select id="explain-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="read">Reading an object</option>
            <option value="relationship">Following a relationship</option>
            <option value="invoke">Invoking an Action</option>
            <option value="query">Running a query</option>
            <option value="workflow">Taking part in a workflow</option>
          </select>
        </div>
        {(kind === "read" || kind === "relationship") && (
          <>
            <div className="field">
              <label htmlFor="explain-type">Type</label>
              <select id="explain-type" value={type} onChange={(e) => setType(e.target.value)}>
                {model.types.map((t) => (
                  <option key={t.name}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="explain-id">Object id</label>
              <input id="explain-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. AF86-0147" />
            </div>
          </>
        )}
        {kind === "relationship" && (
          <div className="field">
            <label htmlFor="explain-rel">Relationship</label>
            <select id="explain-rel" value={relationship} onChange={(e) => setRelationship(e.target.value)}>
              <option value="">Choose one</option>
              {typeDesc?.relationships.map((r) => (
                <option key={r.name}>{r.name}</option>
              ))}
            </select>
          </div>
        )}
        {kind === "invoke" && (
          <>
            <div className="field">
              <label htmlFor="explain-action">Action</label>
              <select id="explain-action" value={action} onChange={(e) => setAction(e.target.value)}>
                {model.actions.map((a) => (
                  <option key={a.name}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="explain-input">Input</label>
              <textarea id="explain-input" rows={6} value={input} onChange={(e) => setInput(e.target.value)} />
            </div>
          </>
        )}
        {kind === "query" && (
          <div className="field">
            <label htmlFor="explain-query">Query</label>
            <textarea id="explain-query" rows={8} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
        {kind === "workflow" && (
          <div className="field">
            <label htmlFor="explain-workflow">Workflow</label>
            <select id="explain-workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
              {workflows.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="explain-as">For</label>
          {subjects ? (
            <select id="explain-as" value={as} onChange={(e) => setAs(e.target.value)}>
              <option value="">Myself</option>
              {subjects.map((s) => (
                <option key={s.subjectId} value={s.subjectId}>
                  {s.label ?? s.subjectId}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted">Myself. Explaining someone else&apos;s access needs the inspection policy.</span>
          )}
        </div>
        <button className="primary" onClick={() => void run()} disabled={busy}>
          Explain
        </button>
      </aside>
      <section data-testid="explanation">
        <ErrorNote error={error} />
        {result && "outcome" in result && (
          <>
            <div className="row">
              <span className={`badge ${result.outcome === "allowed" ? "good" : result.outcome === "partial" ? "warn" : "error"}`} data-testid="outcome">
                {result.outcome}
              </span>
              <strong>{result.summary}</strong>
            </div>
            <p className="muted">
              For <code>{result.subject}</code>
              {result.audience && <> reading for {result.audience}</>}, explained to <code>{result.investigator}</code> with {result.disclosure === "inspector" ? "policies, rules and sources shown" : "only what a refusal tells the caller"}.
            </p>
            <Findings findings={result.findings} />
            {result.effects && (
              <p>
                If it ran: side effects <strong>{result.effects.sideEffects}</strong>, idempotency {result.effects.idempotency}
                {result.effects.auditRequired && ", audited"}
                {result.effects.source && <>, lands in {result.effects.source}</>}.
              </p>
            )}
            {result.observed.length > 0 && (
              <>
                <h3>Earlier decisions, from the audit log</h3>
                <table data-testid="observed">
                  <thead>
                    <tr>
                      <th>At</th>
                      <th>Operation</th>
                      <th>Value</th>
                      <th>Decision</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.observed.map((o, i) => (
                      <tr key={i}>
                        <td>{o.at}</td>
                        <td>{o.operation ?? o.action}</td>
                        <td>{o.member ?? ""}</td>
                        <td>{o.decision}</td>
                        <td>{o.reason ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <p className="muted">{result.caveat}</p>
          </>
        )}
        {result && "canStart" in result && (
          <>
            <div className="row">
              <span className={`badge ${result.canStart ? "good" : "error"}`} data-testid="outcome">
                {result.canStart ? "may start" : "may not start"}
              </span>
              <strong>{result.workflow}</strong>
            </div>
            <Findings findings={result.findings} />
            <p className="muted">{result.caveat}</p>
          </>
        )}
      </section>
    </div>
  );
}
