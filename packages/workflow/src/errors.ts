/** One problem with a workflow definition, found before any run starts. */
export interface WorkflowDiagnostic {
  readonly code:
    | "invalid-name"
    | "duplicate-step"
    | "unknown-need"
    | "unknown-action"
    | "unreviewed-ai-output"
    | "retry-not-idempotent"
    | "invalid-retry"
    | "invalid-deadline"
    | "invalid-schema"
    | "missing-policy"
    | "unreleasable-ai-input";
  readonly step?: string;
  readonly message: string;
}

/** The definition cannot be run: its diagnostics say why. */
export class WorkflowDefinitionError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: readonly WorkflowDiagnostic[] = []
  ) {
    super(diagnostics.length ? `${message}: ${diagnostics.map((d) => d.message).join("; ")}` : message);
    this.name = "WorkflowDefinitionError";
  }
}

/** The run is not in a state that allows this call: approving a step it is not waiting on, resuming a finished run. */
export class WorkflowStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStateError";
  }
}

/** Another writer appended to this run first; nothing was written. Re-read and try again. */
export class JournalConflictError extends Error {
  constructor(
    public readonly runId: string,
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(`Journal for run ${runId} has ${actual} events, expected ${expected}`);
    this.name = "JournalConflictError";
  }
}

/**
 * The definition no longer reproduces what the journal recorded for this run
 * (a step renamed, a compute step that now returns something else, an
 * Action input computed differently). The run is left untouched.
 */
export class ReplayDivergenceError extends Error {
  constructor(
    public readonly step: string,
    message: string
  ) {
    super(`Replay diverged at step "${step}": ${message}`);
    this.name = "ReplayDivergenceError";
  }
}

/**
 * An AI step's input would include something its model may not receive
 * (ADR-0067). Not retryable: the same data and the same model give the same
 * answer. `withheld` names the steps whose outputs differ.
 */
export class ReleaseRefusedError extends Error {
  constructor(
    message: string,
    public readonly audience: string,
    public readonly withheld: readonly string[]
  ) {
    super(message);
    this.name = "ReleaseRefusedError";
  }
}

/** A model's answer that its step's `outputSchema` does not admit. Retryable: a model may answer differently next time. */
export class AiOutputError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    public readonly errors?: unknown
  ) {
    super(message);
    this.name = "AiOutputError";
  }
}

/**
 * Injected by a fault plan to stand for the process dying: it escapes the
 * engine with nothing journaled for the step's outcome, exactly as a crash
 * would leave the journal.
 */
export class SimulatedCrash extends Error {
  constructor(
    public readonly step: string,
    public readonly at: "before-effect" | "after-effect"
  ) {
    super(`Simulated crash at step "${step}" (${at})`);
    this.name = "SimulatedCrash";
  }
}

/** A step that cannot be simulated as asked: an AI step with no scripted answer, an Action the preview blocks. */
export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationError";
  }
}

/** Retryable when the error says so (`retryable: true`, as core's adapter timeouts do); everything else is final. */
export function isRetryable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { retryable?: unknown }).retryable === true;
}
