import { randomUUID } from "node:crypto";
import {
  AuthorizationError,
  InvalidInputError,
  createSemanticValidator,
  describeModel,
  type ActionDescription,
  type Identity,
  type ModelDescription,
  type PolicyEngine,
  type SemanticRegistry,
  type SemanticRuntime
} from "@typesys/core";
import { createClient, runtimeTransport, type ModelShape } from "@typesys/sdk";
import type { ValidateFunction } from "ajv";
import type { AiModel } from "./ai.js";
import type { AnyStep, AnyWorkflow, StepContext, WorkflowDefinition } from "./definition.js";
import { AiOutputError, SimulatedCrash, WorkflowDefinitionError, WorkflowStateError, isRetryable } from "./errors.js";
import type { FinalStatus, JournalEvent, JournalRecord, OutputSource, WorkflowJournal } from "./journal.js";
import { InMemoryJournal } from "./journal.js";
import { contextFor, outputsOf, verifyReplay } from "./replay.js";
import { fold, viewOf, type RunState, type RunView } from "./state.js";
import { validateWorkflow } from "./validate.js";

/** What the engine runs on: a built runtime (`buildRuntime`, or a domain's testbed). */
export interface WorkflowHost {
  readonly runtime: SemanticRuntime;
  readonly policyEngine: PolicyEngine;
  readonly registry: SemanticRegistry;
}

/**
 * A fault to inject at one attempt of one step (ADR-0057): an error thrown in
 * place of the step's effect, or a crash, before or after the effect, that
 * leaves the journal as a dying process would. Key a compensation's faults
 * by `<step>.compensate`.
 */
export interface Fault {
  /** The attempt it applies to; default every attempt. */
  readonly attempt?: number;
  readonly error?: Error;
  readonly crash?: "before-effect" | "after-effect";
}
export type FaultPlan = Readonly<Record<string, readonly Fault[]>>;

export interface WorkflowEngineOptions {
  readonly host: WorkflowHost;
  /** Default: a fresh `InMemoryJournal`, which a restart loses. */
  readonly journal?: WorkflowJournal;
  /** Required by any workflow with an AI step. */
  readonly model?: AiModel;
  /**
   * Re-resolves the initiator each time a run advances, so a run started by
   * someone whose roles were since revoked continues with what they hold now.
   * Without it, a run acts as the initiator was at start.
   */
  readonly resolveIdentity?: (snapshot: Identity) => Promise<Identity>;
  /** For tests and game days, never production. */
  readonly faults?: FaultPlan;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

/** What an admitted approver is shown. */
export interface PendingApproval {
  readonly runId: string;
  readonly workflow: string;
  readonly step: string;
  readonly policy: string;
  readonly initiator: string;
  readonly presented: unknown;
}

const semverParts = (v: string) => v.split(/[.+-]/).slice(0, 3).map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [semverParts(a), semverParts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
const recorded = (err: unknown) => ({ name: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) });

/** Appends to one run, conditionally on its length, and keeps the folded state current. */
class RunWriter {
  constructor(
    private readonly journal: WorkflowJournal,
    private readonly records: JournalRecord[],
    private readonly now: () => Date,
    public state: RunState
  ) {}

  async append(...events: JournalEvent[]): Promise<void> {
    const at = this.now().toISOString();
    await this.journal.append(this.state.runId, this.records.length, events, at);
    for (const e of events) this.records.push({ ...structuredClone(e), seq: this.records.length, at });
    this.state = fold(this.state.runId, this.records);
  }
}

/**
 * Runs governed workflows over a TypeS runtime (ADR-0057). It orchestrates
 * and remembers; it decides nothing the runtime decides. Every read and
 * Action of a run goes through the runtime as the run's initiator, so policy,
 * classification, preconditions and audit apply to a workflow exactly as to
 * the person who started it. What the engine adds is the run: a journal that
 * survives a restart, retries of what may be retried, compensation of what
 * completed when a later step fails, approvals decided by policy, and a
 * refusal to repeat an Action that may already have happened.
 */
export class WorkflowEngine {
  private readonly definitions = new Map<string, Map<string, AnyWorkflow>>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = createSemanticValidator();
  private readonly actions: Map<string, ActionDescription>;
  readonly journal: WorkflowJournal;
  protected readonly simulation: boolean = false;

  protected constructor(
    protected readonly options: WorkflowEngineOptions,
    readonly model: ModelDescription
  ) {
    this.journal = options.journal ?? new InMemoryJournal();
    this.actions = new Map(model.actions.map((a) => [a.name, a]));
  }

  /** Describes the model once; `register` then checks each workflow against it. */
  static async create(options: WorkflowEngineOptions): Promise<WorkflowEngine> {
    return new WorkflowEngine(options, await describeModel(options.host.registry));
  }

  /** Registers a workflow version. Throws `WorkflowDefinitionError` with every problem `validateWorkflow` finds. */
  register<M extends ModelShape, I>(workflow: WorkflowDefinition<M, I>): void {
    const w = workflow as unknown as AnyWorkflow;
    const diagnostics = validateWorkflow(w, this.model);
    if (diagnostics.length) throw new WorkflowDefinitionError(`Workflow ${w.name}@${w.version} is not valid`, diagnostics);
    const versions = this.definitions.get(w.name) ?? new Map<string, AnyWorkflow>();
    if (versions.has(w.version)) throw new WorkflowDefinitionError(`Workflow ${w.name}@${w.version} is already registered`);
    versions.set(w.version, w);
    this.definitions.set(w.name, versions);
    this.validators.set(`${w.name}@${w.version}`, this.ajv.compile(w.inputSchema));
  }

  /**
   * Starts a run of the newest registered version, if `initiator` may (the
   * workflow's `startPolicy`) and `input` matches its `inputSchema`, and
   * advances it as far as it goes: to the end, to an approval, or to a failure.
   */
  async start(name: string, input: unknown, initiator: Identity): Promise<RunView> {
    const versions = this.definitions.get(name);
    if (!versions) throw new WorkflowStateError(`Unknown workflow "${name}"`);
    const workflow = [...versions.values()].reduce((a, b) => (newer(b.version, a.version) ? b : a));
    const runId = randomUUID();
    const decision = await this.options.host.policyEngine.evaluate({
      subject: initiator,
      action: "invoke",
      policyName: workflow.startPolicy,
      resource: { typeName: workflow.name, actionName: "start" }
    });
    await this.audit(initiator.subjectId, "workflow.start", workflow, runId, decision.allow ? "allow" : "deny", { reason: decision.reason });
    if (!decision.allow) throw new AuthorizationError(`Not authorized: start ${workflow.name}`, decision.reason);
    const validate = this.validators.get(`${workflow.name}@${workflow.version}`)!;
    if (!validate(input)) throw new InvalidInputError(`Invalid input for workflow "${workflow.name}": ${this.ajv.errorsText(validate.errors)}`, validate.errors);

    await this.journal.append(
      runId,
      0,
      [{ type: "run-started", workflow: workflow.name, version: workflow.version, initiator, input, ...(this.simulation ? { simulation: true as const } : {}) }],
      this.now()
    );
    return this.advance(runId);
  }

  /**
   * Decides the approval a run is waiting on. The approver must be admitted
   * by the step's policy and, unless the step allows it, be someone other
   * than the initiator; either refusal is audited. An approval continues the
   * run; a rejection compensates what it completed and ends it.
   */
  async approve(runId: string, step: string, approver: Identity, decision: { approved: boolean; comment?: string }): Promise<RunView> {
    const { records, state, workflow } = await this.load(runId);
    if (state.finished || state.waitingOn?.step !== step) throw new WorkflowStateError(`Run ${runId} is not waiting on approval "${step}"`);
    // Before the decision is recorded: a definition that no longer reproduces the run must not take one.
    verifyReplay(workflow, state);
    const approval = this.approvalStep(workflow, step);
    await this.admitApprover(workflow, state, approval, approver, "workflow.approve");
    // Conditional on the journal as read above: a second, concurrent decision fails with JournalConflictError.
    await this.writer(state, records).append({
      type: "approval-decided",
      step,
      approver: approver.subjectId,
      approved: decision.approved,
      ...(decision.comment !== undefined ? { comment: decision.comment } : {})
    });
    return this.advance(runId);
  }

  /** What the approval a run waits on presents, to an approver the step's policy admits; refused (and audited) for anyone else. */
  async pendingApproval(runId: string, approver: Identity): Promise<PendingApproval> {
    const { state, workflow } = await this.load(runId);
    if (!state.waitingOn) throw new WorkflowStateError(`Run ${runId} is not waiting on an approval`);
    const approval = this.approvalStep(workflow, state.waitingOn.step);
    await this.admitApprover(workflow, state, approval, approver, "workflow.view-approval");
    const outputs = outputsOf(state);
    const ctx = contextFor(runId, state.input, approval, outputs);
    const presented = approval.present ? approval.present(ctx) : Object.fromEntries((approval.needs ?? []).map((n) => [n, ctx.output(n)]));
    return { runId, workflow: workflow.name, step: approval.name, policy: approval.policy, initiator: state.initiator.subjectId, presented };
  }

  /**
   * Every approval waiting on someone `approver` may be: each run waiting on
   * an approval is decided for them as `pendingApproval` decides it, and
   * audited, and only the admitted ones are returned. It reads every run in
   * the journal, which suits the reference journal; a durable journal would
   * index runs by what they wait on.
   */
  async approvalsFor(approver: Identity): Promise<PendingApproval[]> {
    const found: PendingApproval[] = [];
    for (const runId of await this.journal.runs()) {
      const { state } = await this.load(runId);
      if (state.finished || !state.waitingOn) continue;
      try {
        found.push(await this.pendingApproval(runId, approver));
      } catch (err) {
        if (!(err instanceof AuthorizationError)) throw err;
      }
    }
    return found;
  }

  /** Continues a run after a restart, or after a crash: from the journal, never from memory. */
  async resume(runId: string): Promise<RunView> {
    return this.advance(runId);
  }

  /** Resumes every unfinished run that is not waiting on a person. */
  async resumeAll(): Promise<RunView[]> {
    const views: RunView[] = [];
    for (const runId of await this.journal.runs()) {
      const { state } = await this.load(runId);
      if (!state.finished && !state.waitingOn) views.push(await this.advance(runId));
    }
    return views;
  }

  async status(runId: string): Promise<RunView> {
    const { state, workflow } = await this.load(runId);
    return viewOf(state, workflow.steps.map((s) => s.name));
  }

  /** Every completed step's output, to the initiator only: they were read and produced as them. */
  async outputs(runId: string, identity: Identity): Promise<Record<string, unknown>> {
    const { state } = await this.load(runId);
    if (identity.subjectId !== state.initiator.subjectId) throw new AuthorizationError(`Not authorized: outputs of run ${runId}`, "Only the run's initiator reads its outputs");
    return Object.fromEntries(outputsOf(state));
  }

  /** The journal of a run, for a trace or a replay check. It holds what the run read: protect it as you protect the audit log. */
  async trace(runId: string): Promise<JournalRecord[]> {
    return this.journal.read(runId);
  }

  /** Invokes an Action as the initiator. A simulation previews it instead. */
  protected async invokeAction(
    action: ActionDescription,
    input: unknown,
    identity: Identity,
    _state: RunState
  ): Promise<{ output: unknown; simulated?: { wouldExecute: boolean | null; note?: string } }> {
    return { output: await this.options.host.runtime.invokeAction(action.name, input, identity) };
  }

  private async load(runId: string): Promise<{ records: JournalRecord[]; state: RunState; workflow: AnyWorkflow }> {
    const records = await this.journal.read(runId);
    const state = fold(runId, records);
    const workflow = this.definitions.get(state.workflow)?.get(state.version);
    if (!workflow) throw new WorkflowStateError(`Run ${runId} is of ${state.workflow}@${state.version}, which is not registered`);
    return { records, state, workflow };
  }

  private writer(state: RunState, records: JournalRecord[]): RunWriter {
    return new RunWriter(this.journal, records, () => this.options.now?.() ?? new Date(), state);
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private approvalStep(workflow: AnyWorkflow, name: string): Extract<AnyStep, { kind: "approval" }> {
    const step = workflow.steps.find((s) => s.name === name);
    if (step?.kind !== "approval") throw new WorkflowStateError(`"${name}" is not an approval of ${workflow.name}`);
    return step;
  }

  private async admitApprover(
    workflow: AnyWorkflow,
    state: RunState,
    step: Extract<AnyStep, { kind: "approval" }>,
    approver: Identity,
    operation: string
  ): Promise<void> {
    if (!step.allowSelfApproval && approver.subjectId === state.initiator.subjectId) {
      const reason = "The initiator of a run may not approve it";
      await this.audit(approver.subjectId, operation, workflow, state.runId, "deny", { step: step.name, reason });
      throw new AuthorizationError(`Not authorized: ${operation} ${workflow.name}/${step.name}`, reason);
    }
    const decision = await this.options.host.policyEngine.evaluate({
      subject: approver,
      action: "invoke",
      policyName: step.policy,
      resource: { typeName: workflow.name, actionName: step.name },
      context: { runId: state.runId, initiator: state.initiator.subjectId }
    });
    await this.audit(approver.subjectId, operation, workflow, state.runId, decision.allow ? "allow" : "deny", { step: step.name, reason: decision.reason });
    if (!decision.allow) throw new AuthorizationError(`Not authorized: ${operation} ${workflow.name}/${step.name}`, decision.reason);
  }

  private async audit(
    subjectId: string,
    action: string,
    workflow: AnyWorkflow,
    runId: string,
    decision: "allow" | "deny",
    extra: { step?: string; reason?: string | undefined; outcome?: "success" | "failure"; status?: string }
  ): Promise<void> {
    await this.options.host.registry.appendAuditEvent({
      id: randomUUID(),
      timestamp: this.now(),
      subjectId,
      operation: "workflow",
      action,
      resource: { typeName: workflow.name, objectId: runId },
      decision,
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra.outcome ? { outcome: extra.outcome } : {}),
      details: {
        version: workflow.version,
        ...(extra.step ? { step: extra.step } : {}),
        ...(extra.status ? { status: extra.status } : {}),
        ...(this.simulation ? { simulation: true } : {})
      }
    });
  }

  private faults(key: string, attempt: number): Fault | undefined {
    return this.options.faults?.[key]?.find((f) => f.attempt === undefined || f.attempt === attempt);
  }

  /** Moves a run forward from what its journal holds, until it finishes or waits on a person. */
  private async advance(runId: string): Promise<RunView> {
    const { records, state, workflow } = await this.load(runId);
    const view = (s: RunState) => viewOf(s, workflow.steps.map((st) => st.name));
    if (state.finished) return view(state);
    verifyReplay(workflow, state);
    const w = this.writer(state, records);
    const identity = this.options.resolveIdentity ? await this.options.resolveIdentity(state.initiator) : state.initiator;

    if (!w.state.compensating) {
      for (const step of workflow.steps) {
        const s = w.state.steps.get(step.name);
        if (s?.outcome?.kind === "completed" || s?.outcome?.kind === "skipped") continue;
        if (s?.outcome?.kind === "failed") {
          // Failed before a restart, with its compensation not yet begun.
          await w.append({ type: "compensating", cause: "failed", step: step.name });
          break;
        }
        const ctx = contextFor(runId, w.state.input, step, outputsOf(w.state));
        if (!s && step.when && !step.when(ctx)) {
          await w.append({ type: "step-skipped", step: step.name });
          continue;
        }
        if (step.kind === "approval") {
          const decision = s?.approval?.decision;
          if (!decision) {
            if (!s?.approval?.requested) await w.append({ type: "approval-requested", step: step.name, policy: step.policy });
            return view(w.state);
          }
          if (!decision.approved) {
            await w.append({ type: "compensating", cause: "rejected", step: step.name });
            break;
          }
          await w.append({ type: "step-completed", step: step.name, attempt: 1, output: decision, source: "human" });
          continue;
        }
        if (step.kind === "action" && s?.inFlight && this.actions.get(step.action)!.idempotency === "none") {
          return view(
            await this.finish(w, workflow, "needs-reconciliation", `Action "${step.action}" of step "${step.name}" may have run: its outcome was not recorded, and it is not idempotent`)
          );
        }
        if (!(await this.attempt(w, workflow, step, ctx, identity))) {
          await w.append({ type: "compensating", cause: "failed", step: step.name });
          break;
        }
      }
      if (!w.state.compensating) return view(await this.finish(w, workflow, "completed"));
    }
    return view(await this.compensate(w, workflow, identity));
  }

  /** Runs one step, retrying what may be retried. True when it completed. */
  private async attempt(w: RunWriter, workflow: AnyWorkflow, step: AnyStep, ctx: StepContext, identity: Identity): Promise<boolean> {
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    for (let attempt = (w.state.steps.get(step.name)?.attempts ?? 0) + 1; ; attempt++) {
      let input: unknown;
      try {
        if (step.kind === "action" || step.kind === "ai") input = step.input(ctx);
      } catch (err) {
        await w.append({ type: "step-failed", step: step.name, attempt, error: recorded(err), retryable: false, final: true });
        return false;
      }
      await w.append({
        type: "step-started",
        step: step.name,
        attempt,
        ...(step.kind === "action" ? { action: step.action, input } : step.kind === "ai" ? { input } : {})
      });
      const fault = this.faults(step.name, attempt);
      try {
        if (fault?.crash === "before-effect") throw new SimulatedCrash(step.name, "before-effect");
        if (fault?.error) throw fault.error;
        const result = await this.effect(workflow, step, ctx, input, identity, w.state);
        if (fault?.crash === "after-effect") throw new SimulatedCrash(step.name, "after-effect");
        await w.append({ type: "step-completed", step: step.name, attempt, ...result });
        return true;
      } catch (err) {
        if (err instanceof SimulatedCrash) throw err;
        const retryable = isRetryable(err);
        const final = !retryable || attempt >= maxAttempts;
        await w.append({ type: "step-failed", step: step.name, attempt, error: recorded(err), retryable, final });
        if (final) return false;
        const delay = (step.retry?.backoffMs ?? 0) * 2 ** (attempt - 1);
        if (delay > 0) await (this.options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
      }
    }
  }

  private async effect(
    workflow: AnyWorkflow,
    step: AnyStep,
    ctx: StepContext,
    input: unknown,
    identity: Identity,
    state: RunState
  ): Promise<{ output: unknown; source: OutputSource; model?: string; simulated?: { wouldExecute: boolean | null; note?: string } }> {
    switch (step.kind) {
      case "read": {
        const client = createClient<ModelShape>(runtimeTransport(this.options.host.runtime, identity));
        return { output: structuredClone(await step.run(client, ctx)), source: "read" };
      }
      case "compute":
        return { output: structuredClone(step.run(ctx)), source: "compute" };
      case "ai": {
        const model = this.options.model;
        if (!model) throw new WorkflowDefinitionError(`Workflow ${workflow.name} has AI step "${step.name}", and the engine has no model`);
        const answer = await model.complete({ workflow: workflow.name, step: step.name, prompt: step.prompt, input, outputSchema: step.outputSchema });
        const key = `${workflow.name}@${workflow.version}#${step.name}`;
        let validate = this.validators.get(key);
        if (!validate) this.validators.set(key, (validate = this.ajv.compile(step.outputSchema)));
        if (!validate(answer)) throw new AiOutputError(`The model's answer to step "${step.name}" does not match its outputSchema: ${this.ajv.errorsText(validate.errors)}`, validate.errors);
        return { output: answer, source: "model", model: model.id };
      }
      case "action": {
        const { output, simulated } = await this.invokeAction(this.actions.get(step.action)!, input, identity, state);
        return { output: structuredClone(output), source: "action", ...(simulated ? { simulated } : {}) };
      }
      case "approval":
        throw new WorkflowStateError("An approval has no effect to run");
    }
  }

  /** Undoes every completed Action step that declares a compensation, newest first, then ends the run. */
  private async compensate(w: RunWriter, workflow: AnyWorkflow, identity: Identity): Promise<RunState> {
    const cause = w.state.compensating!;
    const done = workflow.steps.filter((s): s is Extract<AnyStep, { kind: "action" }> => s.kind === "action" && w.state.steps.get(s.name)?.outcome?.kind === "completed");
    for (const step of done.reverse()) {
      const s = w.state.steps.get(step.name)!;
      if (!step.compensate || s.compensation === "completed") continue;
      const undo = this.actions.get(step.compensate.action)!;
      if (s.compensation === "failed" || (s.compensation === "started" && undo.idempotency === "none")) {
        return this.finish(w, workflow, "needs-reconciliation", `Compensation of step "${step.name}" did not complete`);
      }
      let input: unknown;
      try {
        const output = s.outcome?.kind === "completed" ? s.outcome.output : undefined;
        input = step.compensate.input(contextFor(w.state.runId, w.state.input, step, outputsOf(w.state)), output);
      } catch (err) {
        await w.append({ type: "compensation-failed", step: step.name, error: recorded(err) });
        return this.finish(w, workflow, "needs-reconciliation", `Compensation of step "${step.name}" failed: ${recorded(err).message}`);
      }
      await w.append({ type: "compensation-started", step: step.name, action: undo.name, input });
      const fault = this.faults(`${step.name}.compensate`, 1);
      try {
        if (fault?.crash === "before-effect") throw new SimulatedCrash(`${step.name}.compensate`, "before-effect");
        if (fault?.error) throw fault.error;
        const { output } = await this.invokeAction(undo, input, identity, w.state);
        if (fault?.crash === "after-effect") throw new SimulatedCrash(`${step.name}.compensate`, "after-effect");
        await w.append({ type: "compensation-completed", step: step.name, output: structuredClone(output) });
      } catch (err) {
        if (err instanceof SimulatedCrash) throw err;
        await w.append({ type: "compensation-failed", step: step.name, error: recorded(err) });
        return this.finish(w, workflow, "needs-reconciliation", `Compensation of step "${step.name}" failed: ${recorded(err).message}`);
      }
    }
    const s = w.state.steps.get(cause.step);
    const reason =
      cause.cause === "rejected"
        ? `Approval "${cause.step}" was rejected by ${s?.approval?.decision?.approver ?? "an approver"}`
        : `Step "${cause.step}" failed: ${s?.outcome?.kind === "failed" ? `${s.outcome.error.name}: ${s.outcome.error.message}` : "unknown error"}`;
    return this.finish(w, workflow, cause.cause, reason);
  }

  private async finish(w: RunWriter, workflow: AnyWorkflow, status: FinalStatus, reason?: string): Promise<RunState> {
    await w.append({ type: "run-finished", status, ...(reason !== undefined ? { reason } : {}) });
    await this.audit(w.state.initiator.subjectId, "workflow.finish", workflow, w.state.runId, "allow", {
      outcome: status === "completed" ? "success" : "failure",
      status,
      reason
    });
    return w.state;
  }
}
