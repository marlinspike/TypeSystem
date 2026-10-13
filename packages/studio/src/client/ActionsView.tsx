import { useEffect, useMemo, useState } from "react";
import type { ActionPreview, ModelDescription } from "@typesys/core";
import { coerceForm, formFields, type FormField } from "@typesys/react";
import type { StudioApi } from "./api.js";
import { ErrorNote } from "./ErrorNote.js";

function Field(props: { readonly field: FormField; readonly value: string; readonly error?: string; readonly onChange: (value: string) => void }) {
  const { field, value } = props;
  const id = `field-${field.name}`;
  const hint = field.objectOf ? `The id of the ${field.objectOf} this acts on` : field.description;
  return (
    <div className="field">
      <label htmlFor={id}>
        {field.label}
        {field.required && <span aria-hidden="true"> *</span>}
      </label>
      {field.kind === "select" || field.kind === "boolean" ? (
        <select id={id} value={value} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">—</option>
          {(field.kind === "boolean" ? ["true", "false"] : (field.options ?? []).map(String)).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.kind === "json" ? (
        <textarea id={id} rows={3} spellCheck={false} value={value} onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <input
          id={id}
          value={value}
          onChange={(e) => props.onChange(e.target.value)}
          {...(field.kind === "number" || field.kind === "integer" ? { inputMode: "decimal" as const } : {})}
          {...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })}
        />
      )}
      {hint && <small className="muted">{hint}</small>}
      {props.error && <small className="error">{props.error}</small>}
    </div>
  );
}

/**
 * An Action's form from its input schema (ADR-0058), a preview of exactly
 * what the runtime would decide for this caller with nothing executed
 * (ADR-0053), and an invocation only of the input that was previewed, after
 * the person confirms it.
 */
export function ActionsView(props: {
  readonly api: StudioApi;
  readonly model: ModelDescription;
  readonly selected: string | null;
  readonly onSelect: (name: string) => void;
}) {
  const { api, model } = props;
  const action = model.actions.find((a) => a.name === props.selected) ?? model.actions[0];
  const fields = useMemo(() => (action ? formFields(action) : []), [action]);
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ readonly input: string; readonly result: ActionPreview } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly result: unknown } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRaw({});
    setPreview(null);
    setOutcome(null);
    setError(null);
    setConfirming(false);
  }, [action, api]);

  const coerced = useMemo(() => coerceForm(fields, raw), [fields, raw]);
  // coerceForm writes keys in field order, so equal inputs stringify equally.
  const input = JSON.stringify(coerced.value);
  // An invocation runs only the input that was previewed, and only if the preview said it would execute.
  const ready = preview !== null && preview.input === input && preview.result.wouldExecute && Object.keys(coerced.errors).length === 0;

  if (!action) return <p className="muted">This model has no Actions.</p>;

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

  return (
    <div className="split">
      <aside>
        <ul className="list" data-testid="actions">
          {model.actions.map((a) => (
            <li key={a.name}>
              <button className={a.name === action.name ? "on" : ""} onClick={() => props.onSelect(a.name)}>
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section>
        <h2>{action.name}</h2>
        <p>{action.description}</p>
        <p className="muted">
          Side effects: {action.sideEffects}; idempotency: {action.idempotency}
          {action.target && <>; acts on one {action.target.type}</>}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setConfirming(false);
            setOutcome(null);
            void run(async () => setPreview({ input, result: await api.previewAction(action.name, coerced.value) }));
          }}
        >
          {fields.map((f) => (
            <Field key={f.name} field={f} value={raw[f.name] ?? ""} {...(coerced.errors[f.name] ? { error: coerced.errors[f.name] } : {})} onChange={(v) => setRaw({ ...raw, [f.name]: v })} />
          ))}
          <button type="submit" disabled={busy || Object.keys(coerced.errors).length > 0}>
            Preview
          </button>
        </form>
        <ErrorNote error={error} />
        {preview && (
          <div className="preview" data-testid="preview">
            <h3>{preview.result.wouldExecute ? "Would run" : "Would be refused"}</h3>
            {preview.input !== input && <p className="warn">The form has changed since this preview. Preview again to invoke.</p>}
            <ul>
              <li>Authorized: {preview.result.authorized ? "yes" : "no"}</li>
              <li>Input valid: {preview.result.inputValid === null ? "not checked" : preview.result.inputValid ? "yes" : "no"}</li>
              {preview.result.target && (
                <li>
                  Acts on {preview.result.target.typeName} <code>{preview.result.target.objectId}</code>
                </li>
              )}
              {preview.result.preconditions.map((p) => (
                <li key={p.description}>
                  {p.description}: {p.satisfied === null ? "not evaluated" : p.satisfied ? "met" : "not met"}
                </li>
              ))}
            </ul>
            {preview.result.blockers.length > 0 && (
              <ul className="blockers">
                {preview.result.blockers.map((b) => (
                  <li key={`${b.kind}:${b.message}`}>
                    <span className="badge">{b.kind}</span> {b.message}
                  </li>
                ))}
              </ul>
            )}
            {ready && !confirming && <button onClick={() => setConfirming(true)}>Invoke…</button>}
            {ready && confirming && (
              <p className="confirm">
                This runs {action.name} as you{action.sideEffects === "none" ? "" : `, with side effects (${action.sideEffects})`}.{" "}
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setConfirming(false);
                      setOutcome({ result: await api.invokeAction(action.name, JSON.parse(preview.input) as unknown) });
                      setPreview(null);
                    })
                  }
                >
                  Confirm and invoke
                </button>{" "}
                <button onClick={() => setConfirming(false)}>Cancel</button>
              </p>
            )}
          </div>
        )}
        {outcome && (
          <div data-testid="outcome">
            <h3>Done</h3>
            <pre>{JSON.stringify(outcome.result, null, 2)}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
