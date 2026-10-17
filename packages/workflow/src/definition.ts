import type { JsonSchema2020 } from "@typesys/core";
import type { ActionName, Client, ModelShape } from "@typesys/sdk";

/**
 * What a step's functions see (ADR-0057): the run's input, and the outputs
 * of the steps it declares in `needs`, nothing else. Reading any other step
 * throws, so `needs` is the step's whole data flow, which is what the
 * definition check reasons about.
 */
export interface StepContext<I = unknown> {
  readonly runId: string;
  /** The run's input, as validated against the workflow's `inputSchema` at start. */
  readonly input: I;
  /** The output of a step this one `needs`, or `undefined` when that step was skipped. */
  output<T = unknown>(step: string): T | undefined;
  /**
   * `<runId>:<step>`, the same on every attempt and after every restart: pass
   * it to an Action whose idempotency is `key` so the source system can
   * recognize a repeated call.
   */
  readonly idempotencyKey: string;
}

/** Retried only when the error says it is retryable (a timeout, an unreachable source); never a refusal or bad input. */
export interface RetryPolicy {
  /** Attempts in all, the first included. */
  readonly maxAttempts: number;
  /** Wait before the second attempt, doubling each time after. Default 0. */
  readonly backoffMs?: number;
}

interface StepBase<I> {
  /** Unique in the workflow; `[A-Za-z][A-Za-z0-9_-]*`. */
  readonly name: string;
  readonly description?: string;
  /** Earlier steps whose outputs this step reads. */
  readonly needs?: readonly string[];
  /** Runs the step only when true; otherwise it is skipped and its output is `undefined`. Must be deterministic. */
  readonly when?: (ctx: StepContext<I>) => boolean;
  readonly retry?: RetryPolicy;
}

/** Reads through the runtime as the run's initiator, with the typed client (ADR-0055): policy decides what comes back. */
export interface ReadStep<M extends ModelShape, I> extends StepBase<I> {
  readonly kind: "read";
  readonly run: (client: Client<M>, ctx: StepContext<I>) => Promise<unknown>;
}

/** A pure function of its needs. Re-run on replay and compared with what it returned, so nondeterminism is caught. */
export interface ComputeStep<I> extends StepBase<I> {
  readonly kind: "compute";
  readonly run: (ctx: StepContext<I>) => unknown;
}

/**
 * Asks the engine's `AiModel`. Its output is checked against `outputSchema`
 * and journaled as the model's, never trusted as fact: an Action with side
 * effects that depends on it must sit behind an approval that depends on it
 * too, or the workflow is refused.
 */
export interface AiStep<I> extends StepBase<I> {
  readonly kind: "ai";
  /** One of the engine's `models`, by name (ADR-0081); default the engine's `model`. */
  readonly model?: string;
  /** The instruction, fixed in the definition so it is versioned and reviewable with it. */
  readonly prompt: string;
  /**
   * What the model is given. Everything in it leaves the runtime for the
   * model, so the engine computes it from what the model's audience may
   * receive (ADR-0067): it re-runs the step's upstream reads and computes as
   * the person carrying the run *and* the model, and calls this with those.
   */
  readonly input: (ctx: StepContext<I>) => unknown;
  readonly outputSchema: JsonSchema2020;
  /**
   * When the model may not receive everything the person could have sent
   * it: `"refuse"` (the default) fails the step, `"redact"` sends the model
   * what it may receive. Either way the release is audited.
   */
  readonly release?: "refuse" | "redact";
}

/**
 * Pauses the run until someone the policy admits decides. The policy is
 * evaluated with action `invoke` on resource `{ typeName: <workflow>,
 * actionName: <step> }`. The initiator may not approve their own run unless
 * `allowSelfApproval` says so.
 */
export interface ApprovalStep<I> extends StepBase<I> {
  readonly kind: "approval";
  readonly policy: string;
  readonly allowSelfApproval?: boolean;
  /** What the approver is shown. Default: the outputs of the steps it `needs`. Only an approver the policy admits sees it. */
  readonly present?: (ctx: StepContext<I>) => unknown;
  /**
   * How long the approval may wait (ADR-0065). A durable timer: undecided by
   * then, the approval expires and the run compensates as on a rejection,
   * whether or not the process that requested it is still alive.
   */
  readonly deadline?: { readonly afterMs: number };
}

type ActionInput<M extends ModelShape, A extends ActionName<M>> = M["actions"][A]["input"];
type ActionOutput<M extends ModelShape, A extends ActionName<M>> = M["actions"][A]["output"];

/** An Action that undoes another, given the step's context and the output of the Action it undoes. */
export type Compensation<M extends ModelShape, I, O> = {
  [B in ActionName<M>]: { readonly action: B; readonly input: (ctx: StepContext<I>, output: O) => ActionInput<M, B> };
}[ActionName<M>];

/** Invokes an Action through the runtime as the run's initiator: policy, input schema, preconditions and audit all apply. */
export type ActionStep<M extends ModelShape, I> = {
  [A in ActionName<M>]: StepBase<I> & {
    readonly kind: "action";
    readonly action: A;
    readonly input: (ctx: StepContext<I>) => ActionInput<M, A>;
    /** Run, in reverse order, for every completed Action step when a later step fails or an approval is rejected. */
    readonly compensate?: Compensation<M, I, ActionOutput<M, A>>;
  };
}[ActionName<M>];

export type Step<M extends ModelShape, I> = ReadStep<M, I> | ComputeStep<I> | AiStep<I> | ApprovalStep<I> | ActionStep<M, I>;
export type StepKind = Step<ModelShape, unknown>["kind"];

export interface WorkflowDefinition<M extends ModelShape = ModelShape, I = unknown> {
  /** Qualified like a Type (`airforce.GroundForRepair`); it is the resource every policy decision about the workflow names. */
  readonly name: string;
  /** Semver. A run finishes on the version it started on. */
  readonly version: string;
  readonly description?: string;
  /**
   * Who may start a run: evaluated with action `invoke` on `{ typeName:
   * <workflow>, actionName: "start" }`. It is continuing authority, not a
   * gate passed once: it is decided again for the initiator as they are now
   * before the run takes any step (ADR-0065).
   */
  readonly startPolicy: string;
  /**
   * Who besides the initiator may cancel a run (`{ typeName: <workflow>,
   * actionName: "cancel" }`), and then carries it while it undoes what it
   * completed. Without it only the initiator may.
   */
  readonly cancelPolicy?: string;
  readonly inputSchema: JsonSchema2020;
  readonly steps: readonly Step<M, I>[];
}

/** Types a workflow by a generated model (ADR-0055): `defineWorkflow<AirforceModel, { aircraftId: string }>({ ... })`. */
export function defineWorkflow<M extends ModelShape, I = unknown>(definition: WorkflowDefinition<M, I>): WorkflowDefinition<M, I> {
  return definition;
}

/** A definition with its model erased, as the engine holds it. */
export type AnyWorkflow = WorkflowDefinition<ModelShape, unknown>;
export type AnyStep = Step<ModelShape, unknown>;
