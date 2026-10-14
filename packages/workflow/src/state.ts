import { NotFoundError, type Identity } from "@typesys/core";
import type { AuthorityRole, CompensationCause, FinalStatus, JournalRecord, OutputSource, RecordedError } from "./journal.js";
import { WorkflowStateError } from "./errors.js";

export interface StepState {
  attempts: number;
  /** Started, with no outcome recorded after it: the process stopped mid-step. */
  inFlight: boolean;
  /** The Action and input of the latest attempt (Action and AI steps). */
  action?: string;
  input?: unknown;
  /** An AI step's needs as released to its model (ADR-0067). */
  released?: { audience: string; needs: Readonly<Record<string, unknown>> };
  outcome?: { kind: "completed"; output: unknown; source: OutputSource } | { kind: "skipped" } | { kind: "failed"; error: RecordedError; retryable: boolean };
  approval?: { requested: boolean; decision?: { approver: string; approved: boolean; comment?: string }; expired?: boolean };
  compensation?: "started" | "completed" | "failed";
}

/** A run as its journal says it is. Nothing else holds a run's state. */
export interface RunState {
  runId: string;
  workflow: string;
  version: string;
  initiator: Identity;
  /**
   * Who the run acts as now, and since when (ADR-0065): the initiator as they
   * started it, until they are re-authorized or someone cancels the run.
   */
  authority: { identity: Identity; role: AuthorityRole; at: string };
  /** Set while the run may not act: why. */
  suspended?: { reason: string };
  /** Pending durable timers, by name, with when each is due. */
  timers: Map<string, string>;
  cancelled?: { by: string; reason?: string };
  input: unknown;
  simulation: boolean;
  steps: Map<string, StepState>;
  /** Set when a step failed, an approval was rejected or expired, or the run was cancelled, and completed Actions are being undone. */
  compensating?: { cause: CompensationCause; step: string };
  finished?: { status: FinalStatus; reason?: string };
  waitingOn?: { step: string; policy: string };
  length: number;
  startedAt: string;
  updatedAt: string;
}

export function fold(runId: string, records: readonly JournalRecord[]): RunState {
  const first = records[0];
  if (first?.type !== "run-started") throw new NotFoundError(`No run ${runId}`);
  const state: RunState = {
    runId,
    workflow: first.workflow,
    version: first.version,
    initiator: first.initiator,
    authority: { identity: first.initiator, role: "initiator", at: first.at },
    timers: new Map(),
    input: first.input,
    simulation: first.simulation === true,
    steps: new Map(),
    length: records.length,
    startedAt: first.at,
    updatedAt: records[records.length - 1]!.at
  };
  const step = (name: string): StepState => {
    let s = state.steps.get(name);
    if (!s) state.steps.set(name, (s = { attempts: 0, inFlight: false }));
    return s;
  };
  for (const e of records.slice(1)) {
    switch (e.type) {
      case "step-skipped":
        step(e.step).outcome = { kind: "skipped" };
        break;
      case "step-started": {
        state.timers.delete(`retry:${e.step}`);
        const s = step(e.step);
        s.attempts = e.attempt;
        s.inFlight = true;
        if (e.action !== undefined) s.action = e.action;
        if ("input" in e) s.input = e.input;
        if (e.released) s.released = e.released;
        break;
      }
      case "step-completed":
        Object.assign(step(e.step), { inFlight: false, outcome: { kind: "completed", output: e.output, source: e.source } });
        break;
      case "step-failed": {
        const s = step(e.step);
        s.inFlight = false;
        if (e.final) s.outcome = { kind: "failed", error: e.error, retryable: e.retryable };
        break;
      }
      case "approval-requested":
        step(e.step).approval = { requested: true };
        state.waitingOn = { step: e.step, policy: e.policy };
        break;
      case "approval-decided":
        step(e.step).approval = { requested: true, decision: { approver: e.approver, approved: e.approved, ...(e.comment !== undefined ? { comment: e.comment } : {}) } };
        state.timers.delete(`approval:${e.step}`);
        delete state.waitingOn;
        break;
      case "approval-expired":
        step(e.step).approval = { requested: true, expired: true };
        state.timers.delete(`approval:${e.step}`);
        delete state.waitingOn;
        break;
      case "authority-suspended":
        state.suspended = { reason: e.reason };
        break;
      case "authority-restored":
        state.authority = { identity: e.identity, role: e.role, at: e.at };
        delete state.suspended;
        break;
      case "timer-set":
        state.timers.set(e.timer, e.dueAt);
        break;
      case "cancelled":
        state.cancelled = { by: e.by, ...(e.reason !== undefined ? { reason: e.reason } : {}) };
        delete state.waitingOn;
        break;
      case "compensating":
        state.compensating = { cause: e.cause, step: e.step };
        break;
      case "compensation-started":
        step(e.step).compensation = "started";
        break;
      case "compensation-completed":
        step(e.step).compensation = "completed";
        break;
      case "compensation-failed":
        step(e.step).compensation = "failed";
        break;
      case "run-finished":
        state.finished = { status: e.status, ...(e.reason !== undefined ? { reason: e.reason } : {}) };
        state.timers.clear();
        delete state.waitingOn;
        delete state.suspended;
        break;
      case "run-started":
        throw new WorkflowStateError(`Run ${runId} was started twice`);
    }
  }
  return state;
}

/**
 * `suspended`: the run may not act until its initiator re-authorizes or
 * someone cancels it (ADR-0065). `waiting-timer`: a retry is backing off
 * on a durable timer.
 */
export type RunStatus = "running" | "waiting-approval" | "waiting-timer" | "suspended" | "compensating" | FinalStatus;

/**
 * A run as anyone holding its id may see it: where it is and how each step
 * ended, never a value it read or produced. Values go to the initiator
 * (`WorkflowEngine.outputs`) and to an admitted approver (`pendingApproval`).
 */
export interface RunView {
  readonly runId: string;
  readonly workflow: string;
  readonly version: string;
  readonly status: RunStatus;
  readonly initiator: string;
  readonly waitingOn?: { readonly step: string; readonly policy: string };
  /** Why it finished as it did, or why it is suspended. */
  readonly reason?: string;
  /** Pending durable timers: an approval's deadline, a retry's backoff. */
  readonly timers?: readonly { readonly name: string; readonly dueAt: string }[];
  readonly simulation: boolean;
  readonly steps: readonly {
    readonly name: string;
    readonly status: "completed" | "skipped" | "failed" | "waiting-approval" | "rejected" | "in-flight" | "pending";
    readonly attempts: number;
    readonly source?: OutputSource;
    readonly error?: RecordedError;
    readonly compensation?: "started" | "completed" | "failed";
  }[];
  readonly startedAt: string;
  readonly updatedAt: string;
}

export function viewOf(state: RunState, stepOrder: readonly string[]): RunView {
  const retrying = [...state.timers.keys()].some((t) => t.startsWith("retry:"));
  const status: RunStatus =
    state.finished?.status ??
    (state.suspended ? "suspended" : state.compensating ? "compensating" : state.waitingOn ? "waiting-approval" : retrying ? "waiting-timer" : "running");
  const reason = state.finished?.reason ?? state.suspended?.reason;
  return {
    runId: state.runId,
    workflow: state.workflow,
    version: state.version,
    status,
    initiator: state.initiator.subjectId,
    ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(state.timers.size ? { timers: [...state.timers].map(([name, dueAt]) => ({ name, dueAt })) } : {}),
    simulation: state.simulation,
    steps: stepOrder.map((name) => {
      const s = state.steps.get(name);
      const decided = s?.approval?.decision;
      const stepStatus =
        (decided && !decided.approved) || s?.approval?.expired
          ? "rejected"
          : s?.outcome?.kind ?? (s?.approval?.requested ? "waiting-approval" : s?.inFlight ? "in-flight" : "pending");
      return {
        name,
        status: stepStatus,
        attempts: s?.attempts ?? 0,
        ...(s?.outcome?.kind === "completed" ? { source: s.outcome.source } : {}),
        ...(s?.outcome?.kind === "failed" ? { error: s.outcome.error } : {}),
        ...(s?.compensation ? { compensation: s.compensation } : {})
      };
    }),
    startedAt: state.startedAt,
    updatedAt: state.updatedAt
  };
}
