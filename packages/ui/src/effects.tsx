import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ActionPreview } from "@typesys/core";
import type { WorkflowRun } from "@typesys/sdk";
import { useRouter } from "./router.js";
import { errorText } from "./states.js";
import { useRuntime } from "./runtime.js";
import { humanize } from "./format.js";

/** A pending confirmation: what the runtime says the Action would do, and the person's answer. */
interface Asking {
  readonly title: string;
  readonly preview: ActionPreview;
  readonly input: Readonly<Record<string, unknown>>;
  readonly resolve: (ok: boolean) => void;
}

const ConfirmContext = createContext<((title: string, preview: ActionPreview, input: Readonly<Record<string, unknown>>) => Promise<boolean>) | null>(null);

/**
 * The confirmation an Action asks for (ADR-0053): the runtime's preview of
 * this exact input as this caller (authorized, preconditions, what it
 * declares it does), shown before anything executes. A preview that would
 * not execute can only be closed.
 */
export function ConfirmHost(props: { readonly children?: ReactNode }) {
  const [asking, setAsking] = useState<Asking | undefined>();
  const ref = useRef<HTMLDialogElement>(null);
  const confirm = useCallback(
    (title: string, preview: ActionPreview, input: Readonly<Record<string, unknown>>) => new Promise<boolean>((resolve) => setAsking({ title, preview, input, resolve })),
    []
  );
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (asking && !d.open) d.showModal?.();
    if (!asking && d.open) d.close();
  }, [asking]);
  const answer = (ok: boolean) => {
    asking?.resolve(ok);
    setAsking(undefined);
  };
  const p = asking?.preview;
  return (
    <ConfirmContext.Provider value={confirm}>
      {props.children}
      <dialog ref={ref} className="ts-dialog" aria-labelledby="ts-confirm-title" onCancel={(e) => (e.preventDefault(), answer(false))}>
        {asking && p ? (
          <form method="dialog" onSubmit={(e) => (e.preventDefault(), answer(p.wouldExecute))}>
            <h2 id="ts-confirm-title">{asking.title}</h2>
            <p className="ts-dialog-sub">
              {humanize(p.action)} · {p.effects.sideEffects === "none" ? "reads only" : `changes ${p.effects.sideEffects.replace(/_/g, " ")}`}
              {p.effects.auditRequired ? " · audited" : ""}
            </p>
            <dl className="ts-kv">
              {Object.entries(asking.input).map(([k, v]) => (
                <div key={k}>
                  <dt>{humanize(k)}</dt>
                  <dd>{typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)}</dd>
                </div>
              ))}
            </dl>
            {p.preconditions.length ? (
              <ul className="ts-checks">
                {p.preconditions.map((c, i) => (
                  <li key={i} data-ok={c.satisfied === null ? "unknown" : String(c.satisfied)}>
                    {c.description}
                  </li>
                ))}
              </ul>
            ) : null}
            {p.blockers.length ? (
              <div className="ts-error" role="alert">
                {p.blockers.map((b) => b.message).join(" ")}
              </div>
            ) : null}
            <div className="ts-dialog-actions">
              <button type="button" className="ts-button" onClick={() => answer(false)}>
                {p.wouldExecute ? "Cancel" : "Close"}
              </button>
              {p.wouldExecute ? (
                <button type="submit" className="ts-button ts-primary" autoFocus>
                  Confirm
                </button>
              ) : null}
            </div>
          </form>
        ) : null}
      </dialog>
    </ConfirmContext.Provider>
  );
}

/** The run statuses a run stops moving at, for now. */
export const SETTLED: readonly WorkflowRun["status"][] = ["waiting-approval", "waiting-timer", "suspended", "completed", "failed", "rejected", "cancelled", "needs-reconciliation"];

export interface InvokeOptions {
  /** Ask the person first, with the runtime's preview. Default true; the checker reports turning it off for a side effect. */
  readonly confirm?: boolean;
  /** Types the Action applies to: their data read again after it. */
  readonly invalidates?: readonly string[];
  readonly title?: string;
}

export interface RunOptions {
  /** Types the flow reads or changes: their data read again as the run moves. */
  readonly invalidates?: readonly string[];
  readonly title?: string;
}

/**
 * What an interaction can do (the IR's effects, ADR-0079): set state,
 * navigate, read data again, invoke an Action (previewed and confirmed),
 * start a flow. Each is the person's own call through the governed API.
 */
export interface Effects {
  set(name: string, value: unknown): void;
  navigate(page: string, params?: Readonly<Record<string, unknown>>): void;
  refresh(...data: readonly { refresh(): void }[]): void;
  /** Resolves with the Action's output, or undefined when the person cancelled or it was refused. */
  invoke(action: string, input: () => Readonly<Record<string, unknown>>, opts?: InvokeOptions): Promise<unknown>;
  /** Starts a run; resolves with it once it settles or after a few seconds of running. */
  run(flow: string, input: () => Readonly<Record<string, unknown>>, opts?: RunOptions): Promise<WorkflowRun | undefined>;
  /** Runs an interaction, telling the person when it fails. */
  guard(fn: () => Promise<unknown> | void): void;
}

export function useEffects(setState: (name: string, value: unknown) => void): Effects {
  const runtime = useRuntime();
  const router = useRouter();
  const confirm = useContext(ConfirmContext);
  return useMemo<Effects>(() => {
    const { client, workflows, notify, invalidation } = runtime;
    const fail = (err: unknown) => notify("bad", err instanceof Error && err.name === "UnknownValueError" ? "That needs a value you have not chosen, or may not read." : errorText(err as Error));
    return {
      set: setState,
      navigate: (page, params) => router.navigate(page, params),
      refresh: (...data) => data.forEach((d) => d.refresh()),
      async invoke(action, input, opts = {}) {
        const value = input();
        const handle = client.action(action as never);
        if (opts.confirm !== false) {
          const preview = await handle.preview(value);
          const ok = confirm ? await confirm(opts.title ?? humanize(action), preview, value) : preview.wouldExecute;
          if (!ok) return undefined;
        }
        const out = await handle.invoke(value);
        notify("good", `${opts.title ?? humanize(action)}: done`);
        if (opts.invalidates?.length) invalidation.publish(opts.invalidates);
        return out;
      },
      async run(flow, input, opts = {}) {
        let run = await workflows.start(flow, input());
        notify("info", `${opts.title ?? humanize(flow.split(".").pop() ?? flow)} started`);
        const deadline = Date.now() + 8000;
        while (!SETTLED.includes(run.status) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 400));
          run = await workflows.status(run.runId);
        }
        if (opts.invalidates?.length) invalidation.publish(opts.invalidates);
        if (run.status === "failed" || run.status === "rejected") notify("bad", `${opts.title ?? "The run"} ${run.status}${run.reason ? `: ${run.reason}` : ""}`);
        else if (run.status === "waiting-approval") notify("info", `Waiting for approval${run.waitingOn ? ` (${humanize(run.waitingOn.step)})` : ""}`);
        else if (run.status === "completed") notify("good", `${opts.title ?? "The run"} completed`);
        return run;
      },
      guard(fn) {
        try {
          const r = fn();
          if (r && typeof (r).then === "function") (r).catch(fail);
        } catch (err) {
          fail(err);
        }
      }
    };
  }, [runtime, router, confirm, setState]);
}
