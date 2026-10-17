import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { coerceForm, type FormField } from "@typesys/react";
import type { WorkflowApproval, WorkflowRun } from "@typesys/sdk";
import { SETTLED, type Effects } from "../effects.js";
import { formatValue, humanize, toText } from "../format.js";
import { useRuntime } from "../runtime.js";
import { EmptyState, ErrorNote, Frame, Skeleton, useOverride, type NodeProps } from "../states.js";

export interface FormProps extends NodeProps {
  readonly fx: Effects;
  /** An Action to invoke, or a flow to start. */
  readonly target: { readonly kind: "action"; readonly name: string } | { readonly kind: "flow"; readonly name: string };
  readonly fields: readonly FormField[];
  /** Inputs the person is not asked for; may throw while a value they need is unknown. */
  readonly defaults?: () => Readonly<Record<string, unknown>>;
  readonly submitLabel?: string;
  readonly invalidates?: readonly string[];
  /** After it succeeds: the Action's output, or the run. */
  readonly then?: (result: unknown) => void;
}

function Control(props: { readonly field: FormField; readonly value: unknown; readonly onChange: (v: unknown) => void; readonly error?: string; readonly id: string }) {
  const f = props.field;
  const common = { id: props.id, name: f.name, "aria-invalid": props.error ? true : undefined, "aria-describedby": props.error || f.description ? `${props.id}-help` : undefined, className: "ts-input" } as const;
  let control: ReactNode;
  if (f.kind === "boolean") control = <input {...common} type="checkbox" className="ts-check" checked={props.value === true} onChange={(e) => props.onChange(e.target.checked)} />;
  else if (f.kind === "select")
    control = (
      <select {...common} required={f.required} value={toText(props.value) ?? ""} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">Choose…</option>
        {(f.options ?? []).map((o) => (
          <option key={String(o)} value={String(o)}>
            {typeof o === "string" ? humanize(o) : String(o)}
          </option>
        ))}
      </select>
    );
  else if (f.kind === "json") control = <textarea {...common} rows={3} value={toText(props.value) ?? ""} onChange={(e) => props.onChange(e.target.value)} />;
  else
    control = (
      <input
        {...common}
        type={f.kind === "number" || f.kind === "integer" ? "number" : f.kind === "date-time" ? "datetime-local" : "text"}
        step={f.kind === "integer" ? 1 : f.kind === "number" ? "any" : undefined}
        min={f.min}
        max={f.max}
        maxLength={f.maxLength}
        required={f.required}
        value={toText(props.value) ?? ""}
        onChange={(e) => props.onChange(f.kind === "date-time" && e.target.value ? new Date(e.target.value).toISOString() : e.target.value)}
      />
    );
  return (
    <div className="ts-field" data-kind={f.kind}>
      <label htmlFor={props.id}>
        {f.label}
        {f.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {control}
      {props.error ? (
        <span id={`${props.id}-help`} className="ts-field-error">
          {props.error}
        </span>
      ) : f.description ? (
        <span id={`${props.id}-help`} className="ts-muted">
          {f.description}
        </span>
      ) : null}
    </div>
  );
}

function FormBuiltIn(props: FormProps) {
  const [raw, setRaw] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { value, errors: found } = coerceForm(props.fields, raw);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    props.fx.guard(async () => {
      try {
        const input = () => ({ ...(props.defaults?.() ?? {}), ...value });
        const result = props.target.kind === "action" ? await props.fx.invoke(props.target.name, input, { invalidates: props.invalidates ?? [], title: props.submitLabel ?? props.title ?? humanize(props.target.name) }) : await props.fx.run(props.target.name, input, { invalidates: props.invalidates ?? [], title: props.title ?? humanize(props.target.name.split(".").pop() ?? props.target.name) });
        if (result !== undefined) {
          setRaw({});
          props.then?.(result);
        }
      } finally {
        setBusy(false);
      }
    });
  };
  return (
    <Frame {...props} kind="form">
      <form className="ts-form" onSubmit={submit} noValidate>
        {props.fields.map((f) => (
          <Control key={f.name} id={`${props.id ?? "form"}-${f.name}`} field={f} value={raw[f.name]} error={errors[f.name]} onChange={(v) => setRaw((r) => ({ ...r, [f.name]: v }))} />
        ))}
        <div className="ts-form-actions">
          <button type="submit" className="ts-button ts-primary" disabled={busy}>
            {busy ? "Working…" : (props.submitLabel ?? (props.target.kind === "action" ? "Preview and confirm" : "Start"))}
          </button>
        </div>
      </form>
    </Frame>
  );
}

/** A form for an Action's input (previewed by the runtime, then confirmed) or a flow's (started as the person). */
export function Form(props: FormProps) {
  const C = useOverride("Form", FormBuiltIn);
  return <C {...props} />;
}

/** A presented value, readable: an object's fields, a list's length and first few. */
export function Presented(props: { readonly value: unknown; readonly depth?: number }) {
  const v = props.value;
  const depth = props.depth ?? 0;
  if (v === undefined) return <span className="ts-muted">Not shown to you</span>;
  if (v === null || typeof v !== "object") return <>{formatValue(v, typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? "date-time" : undefined)}</>;
  if (Array.isArray(v))
    return depth > 1 ? (
      <span>{v.length} items</span>
    ) : (
      <ul className="ts-presented-list">
        {(v as unknown[]).slice(0, 5).map((x, i) => (
          <li key={i}>
            <Presented value={x} depth={depth + 1} />
          </li>
        ))}
        {v.length > 5 ? <li className="ts-muted">and {v.length - 5} more</li> : null}
      </ul>
    );
  const entries = Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "$type" && k !== "$unavailable" && k !== "$provenance");
  if (depth > 1) return <span>{entries.filter(([k]) => k !== "$id").map(([k, x]) => `${humanize(k)}: ${typeof x === "object" && x !== null ? "…" : (toText(x) ?? "")}`).slice(0, 3).join(" · ")}</span>;
  return (
    <dl className="ts-kv ts-compact">
      {entries.map(([k, x]) => (
        <div key={k}>
          <dt>{k === "$id" ? "Id" : humanize(k)}</dt>
          <dd>
            <Presented value={x} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface ApprovalsProps extends NodeProps {
  /** Only runs of these workflows (qualified names). */
  readonly flows?: readonly string[];
  /** Workflow → the Types its runs change, read again after a decision. */
  readonly invalidates?: Readonly<Record<string, readonly string[]>>;
  readonly titles?: Readonly<Record<string, string>>;
}

function ApprovalsBuiltIn(props: ApprovalsProps) {
  const { workflows, notify, invalidation, token } = useRuntime();
  const [items, setItems] = useState<WorkflowApproval[] | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [comment, setComment] = useState<Record<string, string>>({});
  const [deciding, setDeciding] = useState<string | undefined>();
  const load = useCallback(() => {
    workflows.approvals().then(
      (all) => (setItems(all.filter((a) => !props.flows || props.flows.includes(a.workflow))), setError(undefined)),
      (e: Error) => setError(e)
    );
  }, [workflows, props.flows]);
  useEffect(() => {
    setItems(undefined);
    load();
    const t = setInterval(load, 5000);
    const off = invalidation.subscribe(["$approvals"], load);
    return () => (clearInterval(t), off());
  }, [load, invalidation, token]);
  const decide = async (a: WorkflowApproval, approved: boolean) => {
    const key = `${a.runId}:${a.step}`;
    setDeciding(key);
    try {
      const run = await workflows.approve(a.runId, a.step, { approved, ...(comment[key] ? { comment: comment[key] } : {}) });
      notify(approved ? "good" : "warn", `${approved ? "Approved" : "Rejected"}: ${props.titles?.[a.workflow] ?? humanize(a.workflow.split(".").pop() ?? a.workflow)} (${humanize(run.status)})`);
      invalidation.publish([...(props.invalidates?.[a.workflow] ?? []), "$runs"]);
      load();
    } catch (e) {
      notify("bad", (e as Error).message);
    } finally {
      setDeciding(undefined);
    }
  };
  return (
    <Frame {...props} kind="approvals" title={props.title ?? "Waiting for your approval"}>
      {error ? <ErrorNote error={error} retry={load} /> : null}
      {!items && !error ? <Skeleton /> : null}
      {items && items.length === 0 ? <EmptyState>Nothing waits on you.</EmptyState> : null}
      <ul className="ts-approval-list">
        {(items ?? []).map((a) => {
          const key = `${a.runId}:${a.step}`;
          return (
            <li key={key} className="ts-approval" data-approval={a.runId}>
              <div className="ts-approval-head">
                <strong>{props.titles?.[a.workflow] ?? humanize(a.workflow.split(".").pop() ?? a.workflow)}</strong>
                <span className="ts-badge" data-tone="warn">
                  {humanize(a.step)}
                </span>
                <span className="ts-muted">started by {a.initiator}</span>
              </div>
              <Presented value={a.presented} />
              <div className="ts-approval-actions">
                <input className="ts-input" placeholder="Comment (optional)" aria-label="Comment" value={comment[key] ?? ""} onChange={(e) => setComment((c) => ({ ...c, [key]: e.target.value }))} />
                <button type="button" className="ts-button" disabled={deciding === key} onClick={() => void decide(a, false)}>
                  Reject
                </button>
                <button type="button" className="ts-button ts-primary" disabled={deciding === key} onClick={() => void decide(a, true)}>
                  Approve
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

/** The signed-in person's approval queue, as the engine decides it: only runs whose policy admits them, never their own. */
export function Approvals(props: ApprovalsProps) {
  const C = useOverride("Approvals", ApprovalsBuiltIn);
  return <C {...props} />;
}

const STATUS_TONE: Readonly<Record<string, string>> = { completed: "good", running: "info", "waiting-approval": "warn", "waiting-timer": "info", suspended: "warn", compensating: "warn", failed: "bad", rejected: "bad", cancelled: "neutral", "needs-reconciliation": "bad" };

/** Follows one run while it moves, then stops. */
export function useRun(runId: string | null | undefined): { run: WorkflowRun | undefined; error: Error | undefined; reload: () => void } {
  const { workflows, invalidation } = useRuntime();
  const [run, setRun] = useState<WorkflowRun | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const reload = useCallback(() => {
    if (!runId) return;
    workflows.status(runId).then(
      (r) => (setRun(r), setError(undefined)),
      (e: Error) => setError(e)
    );
  }, [runId, workflows]);
  useEffect(() => {
    setRun(undefined);
    reload();
    return invalidation.subscribe(["$runs"], reload);
  }, [reload, invalidation]);
  useEffect(() => {
    if (!run || SETTLED.includes(run.status)) return;
    const t = setTimeout(reload, 700);
    return () => clearTimeout(t);
  }, [run, reload]);
  return { run, error, reload };
}

export function RunView(props: NodeProps & { readonly run: string | null | undefined; readonly flowTitle?: string }) {
  const { run, error } = useRun(props.run);
  return (
    <Frame {...props} kind="run" title={props.title ?? props.flowTitle ?? "Run"}>
      {!props.run ? <EmptyState>No run started.</EmptyState> : error ? <ErrorNote error={error} /> : !run ? <Skeleton lines={2} /> : null}
      {run ? (
        <div className="ts-run" data-status={run.status}>
          <div className="ts-run-head">
            <span className="ts-badge" data-tone={STATUS_TONE[run.status] ?? "neutral"}>
              {humanize(run.status)}
            </span>
            {run.waitingOn ? <span className="ts-muted">waiting on {humanize(run.waitingOn.step)}</span> : null}
            {run.reason ? <span className="ts-muted">{run.reason}</span> : null}
          </div>
          <ol className="ts-steps">
            {run.steps.map((s) => (
              <li key={s.name} data-status={s.status}>
                <span className="ts-step-dot" aria-hidden="true" />
                <span>{humanize(s.name)}</span>
                <span className="ts-muted">
                  {humanize(s.status)}
                  {s.attempts > 1 ? ` · ${s.attempts} attempts` : ""}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </Frame>
  );
}

export interface AssistantProps extends NodeProps {
  readonly fx: Effects;
  readonly flow: string;
  /** The flow's input; throws while a value it needs is unknown. */
  readonly input: () => Readonly<Record<string, unknown>>;
  /** The AI step whose answer is shown. */
  readonly step: string;
  readonly prompt?: string;
  readonly into?: (runId: string) => void;
  readonly model?: string;
}

function AssistantBuiltIn(props: AssistantProps) {
  const { workflows } = useRuntime();
  const [runId, setRunId] = useState<string | undefined>();
  const { run } = useRun(runId);
  const [answer, setAnswer] = useState<unknown>();
  const [error, setError] = useState<Error | undefined>();
  const [busy, setBusy] = useState(false);
  const stepDone = run?.steps.find((s) => s.name === props.step)?.status === "completed";
  useEffect(() => {
    if (!runId || !stepDone) return;
    workflows.outputs(runId).then(
      (o) => setAnswer(o[props.step]),
      (e: Error) => setError(e)
    );
  }, [runId, stepDone, workflows, props.step]);
  const ask = () => {
    setBusy(true);
    setAnswer(undefined);
    setError(undefined);
    props.fx.guard(async () => {
      try {
        const started = await props.fx.run(props.flow, props.input, { title: props.title ?? "Assistant" });
        if (started) {
          setRunId(started.runId);
          props.into?.(started.runId);
        }
      } catch (e) {
        setError(e as Error);
      } finally {
        setBusy(false);
      }
    });
  };
  const failed = run && (run.status === "failed" || run.status === "rejected") && !stepDone;
  return (
    <Frame {...props} kind="assistant" title={props.title ?? "Assistant"}>
      <p className="ts-muted ts-ai-note">
        Answers come from {props.model ? <strong>{props.model}</strong> : "a configured model"}, given only what its audience may read. They are proposals: nothing acts on one without a person's approval.
      </p>
      <button type="button" className="ts-button ts-primary" onClick={ask} disabled={busy || (run !== undefined && !SETTLED.includes(run.status))}>
        {busy || (run && !SETTLED.includes(run.status) && !stepDone) ? "Thinking…" : (props.prompt ?? "Ask")}
      </button>
      {error ? <ErrorNote error={error} /> : null}
      {failed ? <ErrorNote error={new Error(run.reason ?? `The run ${run.status}`)} /> : null}
      {answer !== undefined ? (
        <div className="ts-ai-answer" data-answer={props.step}>
          <Presented value={answer} />
        </div>
      ) : null}
    </Frame>
  );
}

/** Contextual AI through a governed flow: its reads and its AI step, released for the model's audience, then shown. */
export function Assistant(props: AssistantProps) {
  const C = useOverride("Assistant", AssistantBuiltIn);
  return <C {...props} />;
}
