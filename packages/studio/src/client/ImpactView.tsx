import { useEffect, useState } from "react";
import type { Baseline, ChangeImpact, ImpactItem } from "@typesys/devkit";
import type { StudioApi } from "./api.js";
import { ErrorNote } from "./ErrorNote.js";

/**
 * Change impact (ADR-0093): a baseline recorded now or loaded from a file,
 * compared with the model as the runtime decides it now. It shows what
 * changed, whose reads changed, and what each change reaches. Nothing in it
 * changes the model.
 */
export function ImpactView({ api }: { api: StudioApi }) {
  const [baseline, setBaseline] = useState<Baseline>();
  const [source, setSource] = useState("");
  const [impact, setImpact] = useState<ChangeImpact>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState<string>();

  useEffect(() => {
    if (!baseline) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(baseline, null, 2)], { type: "application/json" }));
    setDownload(url);
    return () => URL.revokeObjectURL(url);
  }, [baseline]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const record = () =>
    act(async () => {
      setBaseline(await api.impactBaseline());
      setSource("recorded now");
      setImpact(undefined);
    });
  const load = (file: File | undefined) =>
    act(async () => {
      if (!file) return;
      const parsed = JSON.parse(await file.text()) as Baseline;
      if (parsed.format !== "typesys.baseline/1") throw new Error(`${file.name} is not a typesys.baseline/1`);
      setBaseline(parsed);
      setSource(file.name);
      setImpact(undefined);
    });
  const compare = () =>
    act(async () => {
      if (baseline) setImpact(await api.impact(baseline));
    });

  return (
    <div className="split">
      <aside>
        <h2>Baseline</h2>
        <p className="muted">The model and how each caller&apos;s reads are decided, without values. Record one before a change, then compare after it.</p>
        <button onClick={() => void record()} disabled={busy}>
          Record a baseline now
        </button>
        <div className="field">
          <label htmlFor="baseline-file">Or load one</label>
          <input id="baseline-file" type="file" accept="application/json,.json" onChange={(e) => void load(e.target.files?.[0])} />
        </div>
        {baseline && (
          <p data-testid="baseline">
            {source}: {baseline.description.types.length} Types, {baseline.probes.length} reads by {new Set(baseline.probes.map((p) => p.as)).size} callers, recorded by <code>{baseline.by}</code>
            {baseline.inspection ? ", with the inspection" : ", without the inspection"}.{" "}
            {download && (
              <a href={download} download="baseline.json">
                Download
              </a>
            )}
          </p>
        )}
        <button className="primary" onClick={() => void compare()} disabled={busy || !baseline}>
          Compare with the model now
        </button>
      </aside>
      <section data-testid="impact">
        <ErrorNote error={error} />
        {impact && <ImpactReport impact={impact} />}
      </section>
    </div>
  );
}

function tag(i: ImpactItem): { text: string; tone: string } {
  if (i.kind === "contract") return { text: i.impact!, tone: i.impact === "breaking" ? "error" : i.impact === "risky" ? "warn" : "good" };
  return { text: `${i.kind}: ${i.effect}`, tone: i.effect === "widens" ? "error" : "warn" };
}

function ImpactReport({ impact }: { impact: ChangeImpact }) {
  // Most consequential first: a caller newly returned a value, then what breaks a consumer, then governance.
  const rank = (i: ImpactItem) => (i.kind === "observed" && i.effect === "widens" ? 0 : i.impact === "breaking" ? 1 : i.kind === "governance" ? 2 : 3);
  const items = [...impact.items].sort((a, b) => rank(a) - rank(b));
  return (
    <>
      <div className="row">
        <span className={`badge ${impact.verdict === "breaking" ? "error" : impact.verdict === "risky" ? "warn" : "good"}`} data-testid="verdict">
          {impact.verdict}
        </span>
        <strong>
          {impact.items.length === 0 ? "No change since the baseline." : `${impact.items.length} change${impact.items.length === 1 ? "" : "s"}`}
          {impact.exposures.length > 0 && `, ${impact.exposures.length} newly exposed read${impact.exposures.length === 1 ? "" : "s"}`}
        </strong>
      </div>
      <p className="muted">
        Model <code>{impact.before.replace(/^sha256:/, "").slice(0, 12)}</code> then <code>{impact.after.replace(/^sha256:/, "").slice(0, 12)}</code>.{" "}
        {impact.governance === "unavailable" && "Governance was not compared: a baseline was recorded by someone who may not inspect. "}
        {impact.observed === "unavailable" && "No reads were probed."}
      </p>
      {items.length > 0 && (
        <table data-testid="impact-items">
          <thead>
            <tr>
              <th>Change</th>
              <th>Subject</th>
              <th>Caller</th>
              <th>What</th>
              <th>Reaches</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i, n) => {
              const t = tag(i);
              return (
                <tr key={n}>
                  <td>
                    <span className={`badge ${t.tone}`}>{t.text}</span>
                    <div className="muted">{i.basis}</div>
                  </td>
                  <td>
                    <code>{i.subject}</code>
                    {i.object && <div className="muted">on {i.object}</div>}
                  </td>
                  <td>{i.as ?? ""}</td>
                  <td>{i.change}</td>
                  <td>{i.reaches.consumers.length ? i.reaches.consumers.join(", ") : <span className="muted">nothing built on it</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {impact.underVersioned.length > 0 && (
        <p>
          Under-versioned:{" "}
          {impact.underVersioned.map((v) => (
            <span key={v.subject}>
              <code>{v.subject}</code> {v.from} to {v.to} needs a {v.needs} bump.{" "}
            </span>
          ))}
        </p>
      )}
      {impact.checks.length > 0 && (
        <p data-testid="impact-checks">
          Checks to run: {impact.checks.map((c) => <code key={c}>{c.replace(/^part:/, "")} </code>)}
        </p>
      )}
      <p className="muted">{impact.caveat}</p>
    </>
  );
}
