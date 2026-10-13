import type { Identity } from "@typesys/core";
import { JournalConflictError } from "./errors.js";

/** Where a step's output came from, so a reader of the journal can tell fact from a model's answer. */
export type OutputSource = "read" | "compute" | "model" | "human" | "action";

/** An error as the journal keeps it: its class and message, never a stack. */
export interface RecordedError {
  readonly name: string;
  readonly message: string;
}

/**
 * Everything that happens to a run (ADR-0057). The run's state is a fold of
 * its events and nothing else, so a process that dies loses nothing that was
 * appended, and a new process resumes from exactly there.
 */
export type JournalEvent =
  | {
      readonly type: "run-started";
      readonly workflow: string;
      readonly version: string;
      /** The initiator as they were at start. Every read and Action of the run is made as them. */
      readonly initiator: Identity;
      readonly input: unknown;
      readonly simulation?: true;
    }
  | { readonly type: "step-skipped"; readonly step: string }
  | {
      readonly type: "step-started";
      readonly step: string;
      readonly attempt: number;
      /** For an Action step, the Action and the input it is about to be invoked with; for an AI step, what the model is given. */
      readonly action?: string;
      readonly input?: unknown;
    }
  | {
      readonly type: "step-completed";
      readonly step: string;
      readonly attempt: number;
      readonly output: unknown;
      readonly source: OutputSource;
      /** The model that answered, for an AI step. */
      readonly model?: string;
      /** In a simulation, what the Action's preview decided; `wouldExecute: null` when it could not be checked. */
      readonly simulated?: { readonly wouldExecute: boolean | null; readonly note?: string };
    }
  | {
      readonly type: "step-failed";
      readonly step: string;
      readonly attempt: number;
      readonly error: RecordedError;
      readonly retryable: boolean;
      /** No attempt follows: the error is not retryable, or the step's attempts are spent. */
      readonly final: boolean;
    }
  | { readonly type: "approval-requested"; readonly step: string; readonly policy: string }
  | { readonly type: "approval-decided"; readonly step: string; readonly approver: string; readonly approved: boolean; readonly comment?: string }
  | { readonly type: "compensating"; readonly cause: "failed" | "rejected"; readonly step: string }
  | { readonly type: "compensation-started"; readonly step: string; readonly action: string; readonly input: unknown }
  | { readonly type: "compensation-completed"; readonly step: string; readonly output: unknown }
  | { readonly type: "compensation-failed"; readonly step: string; readonly error: RecordedError }
  | { readonly type: "run-finished"; readonly status: FinalStatus; readonly reason?: string };

export type FinalStatus = "completed" | "failed" | "rejected" | "needs-reconciliation";

/** One appended event: its position in the run (from 0) and when it was written. */
export type JournalRecord = JournalEvent & { readonly seq: number; readonly at: string };

/**
 * The durability seam. An implementation must make `append` atomic and
 * conditional: it writes all of `events` only if the run still has
 * `expectedLength` events, and otherwise throws `JournalConflictError`, so two
 * processes advancing one run cannot both write. A table keyed by
 * `(run_id, seq)` with a unique constraint is enough.
 */
export interface WorkflowJournal {
  append(runId: string, expectedLength: number, events: readonly JournalEvent[], at: string): Promise<void>;
  read(runId: string): Promise<JournalRecord[]>;
  /** Every run with a journal, for a process that resumes unfinished runs after a restart. */
  runs(): Promise<string[]>;
}

/** The reference journal, in memory: for tests, simulation, and a single process that may lose its runs. */
export class InMemoryJournal implements WorkflowJournal {
  private readonly byRun = new Map<string, JournalRecord[]>();

  async append(runId: string, expectedLength: number, events: readonly JournalEvent[], at: string): Promise<void> {
    const records = this.byRun.get(runId) ?? [];
    if (records.length !== expectedLength) throw new JournalConflictError(runId, expectedLength, records.length);
    for (const event of events) records.push(structuredClone({ ...event, seq: records.length, at }));
    this.byRun.set(runId, records);
  }

  async read(runId: string): Promise<JournalRecord[]> {
    return structuredClone(this.byRun.get(runId) ?? []);
  }

  async runs(): Promise<string[]> {
    return [...this.byRun.keys()];
  }
}
