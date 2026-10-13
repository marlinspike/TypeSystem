import type { Identity } from "@typesys/core";
import type { FinalStatus, JournalRecord, OutputSource, RecordedError } from "./journal.js";
import { WorkflowStateError } from "./errors.js";

export interface StepState {
  attempts: number;
  /** Started, with no outcome recorded after it: the process stopped mid-step. */
  inFlight: boolean;
  /** The Action and input of the latest attempt (Action and AI steps). */
  action?: string;
  input?: unknown;
  outcome?: { kind: "completed"; output: unknown; source: OutputSource } | { kind: "skipped" } | { kind: "failed"; error: RecordedError };
  approval?: { requested: boolean; decision?: { approver: string; approved: boolean; comment?: string } };
  compensation?: "started" | "completed" | "failed";
}

/** A run as its journal says it is. Nothing else holds a run's state. */
export interface RunState {
  runId: string;
  workflow: string;
  version: string;
  initiator: Identity;
  input: unknown;
  simulation: boolean;
  steps: Map<string, StepState>;
  /** Set when a step failed or an approval was rejected and completed Actions are being undone. */
  compensating?: { cause: "failed" | "rejected"; step: string };
  finished?: { status: FinalStatus; reason?: string };
  waitingOn?: { step: string; policy: string };
  length: number;
  startedAt: string;
  updatedAt: string;
}

export function fold(runId: string, records: readonly JournalRecord[]): RunState {
  const first = records[0];
  if (first?.type !== "run-started") throw new WorkflowStateError(`No run ${runId}`);
  const state: RunState = {
    runId,
    workflow: first.workflow,
    version: first.version,
    initiator: first.initiator,
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
        const s = step(e.step);
        s.attempts = e.attempt;
        s.inFlight = true;
        if (e.action !== undefined) s.action = e.action;
        if ("input" in e) s.input = e.input;
        break;
      }
      case "step-completed":
        Object.assign(step(e.step), { inFlight: false, outcome: { kind: "completed", output: e.output, source: e.source } });
        break;
      case "step-failed": {
        const s = step(e.step);
        s.inFlight = false;
        if (e.final) s.outcome = { kind: "failed", error: e.error };
        break;
      }
      case "approval-requested":
        step(e.step).approval = { requested: true };
        state.waitingOn = { step: e.step, policy: e.policy };
        break;
      case "approval-decided":
        step(e.step).approval = { requested: true, decision: { approver: e.approver, approved: e.approved, ...(e.comment !== undefined ? { comment: e.comment } : {}) } };
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
        delete state.waitingOn;
        break;
      case "run-started":
        throw new WorkflowStateError(`Run ${runId} was started twice`);
    }
  }
  return state;
}

export type RunStatus = "running" | "waiting-approval" | "compensating" | FinalStatus;

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
  readonly reason?: string;
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
  const status: RunStatus = state.finished?.status ?? (state.compensating ? "compensating" : state.waitingOn ? "waiting-approval" : "running");
  return {
    runId: state.runId,
    workflow: state.workflow,
    version: state.version,
    status,
    initiator: state.initiator.subjectId,
    ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
    ...(state.finished?.reason !== undefined ? { reason: state.finished.reason } : {}),
    simulation: state.simulation,
    steps: stepOrder.map((name) => {
      const s = state.steps.get(name);
      const decided = s?.approval?.decision;
      const stepStatus =
        decided && !decided.approved
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
