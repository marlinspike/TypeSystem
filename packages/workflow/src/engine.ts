import { randomUUID } from "node:crypto";
import {
  AuthorizationError,
  InvalidInputError,
  NotFoundError,
  canonical,
  createSemanticValidator,
  decideForIdentity,
  describeModel,
  withAudience,
  type ActionDescription,
  type Identity,
  type ModelDescription,
  type PolicyEngine,
  type SemanticRegistry,
  type SemanticRuntime
} from "@typesys/core";
import { createClient, runtimeTransport, type ModelShape, type Transport } from "@typesys/sdk";
import type { ValidateFunction } from "ajv";
import { audienceOf, type AiModel } from "./ai.js";
import type { AnyStep, AnyWorkflow, StepContext, WorkflowDefinition } from "./definition.js";
import { AiOutputError, JournalConflictError, ReleaseRefusedError, SimulatedCrash, WorkflowDefinitionError, WorkflowStateError, isRetryable } from "./errors.js";
import type { CompensationCause, FinalStatus, JournalEvent, JournalRecord, OutputSource, WorkflowJournal } from "./journal.js";
import { InMemoryJournal } from "./journal.js";
import { contextFor, outputsOf, reviewsAiOutput, verifyReplay } from "./replay.js";

/** The failures of a model that move an AI step to its next model (ADR-0075): the model not answering, never an answer it gave. */
const UNAVAILABLE = new Set(["unavailable", "overloaded", "rate-limited", "timeout"]);
function modelUnavailable(err: unknown): boolean {
  // A model from @typesys/llm says which failure it was; a malformed or refused answer is not a reason to ask another model.
  const code = err instanceof Error && err.name === "LlmError" ? (err as Error & { code?: unknown }).code : undefined;
  if (typeof code === "string") return UNAVAILABLE.has(code);
  return isRetryable(err);
}
import { fold, viewOf, type RunState, type RunView } from "./state.js";
import { upstream, validateWorkflow } from "./validate.js";

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
   * Re-resolves the identity a run acts as each time it advances (ADR-0065),
   * from your directory or identity provider, so a run continues with what its
   * initiator holds now, never with what they held at start. Throw an
   * `AuthorizationError` or `NotFoundError` for a subject that is revoked or
   * gone: the run is suspended. Any other error is transient: the run is left
   * as it was, to be resumed. Without it, a run acts on the identity it holds
   * only until that is `identityMaxAgeMs` old, then waits for its initiator
   * to re-authorize.
   */
  readonly resolveIdentity?: (snapshot: Identity) => Promise<Identity>;
  /** How long a run may act on an identity it cannot re-resolve. Default 15 minutes. */
  readonly identityMaxAgeMs?: number;
  /**
   * A retry's backoff up to this long is waited out in process (and is still
   * journaled, so a crash during it honors it); a longer one ends the call
   * with the run `waiting-timer`, for `tick()` to continue. Default 1 second.
   */
  readonly inlineWaitMs?: number;
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
const DEFAULT_IDENTITY_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_INLINE_WAIT_MS = 1_000;
const due = (dueAt: string | undefined, now: Date) => dueAt !== undefined && Date.parse(dueAt) <= now.getTime();
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
 * Runs governed workflows over a TypeSys runtime (ADR-0057). It orchestrates
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
    // A limit that is not a number would disable the check it sets (ADR-0065).
    for (const key of ["identityMaxAgeMs", "inlineWaitMs"] as const) {
      const v = options[key];
      if (v !== undefined && !(Number.isFinite(v) && v >= 0)) throw new TypeError(`WorkflowEngine option ${key} must be a finite number of milliseconds, 0 or more; got ${v}`);
    }
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
    const decision = await decideForIdentity(this.options.host.policyEngine, {
      subject: initiator,
      action: "invoke",
      policyName: workflow.startPolicy,
      resource: { typeName: workflow.name, actionName: "start" }
    });
    await this.audit(initiator, "workflow.start", workflow, runId, decision.allow ? "allow" : "deny", { reason: decision.reason });
    // A caller acting for an audience is told one thing whoever its user is (ADR-0067); the audit row keeps the reason.
    if (!decision.allow) throw new AuthorizationError(`Not authorized: start ${workflow.name}`, initiator.audience ? `Refused while reading for ${initiator.audience.id}` : decision.reason);
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
    // A decision that arrives after the deadline is too late, whether or not a tick has expired the approval yet.
    const deadline = state.timers.get(`approval:${step}`);
    if (due(deadline, this.options.now?.() ?? new Date())) {
      await this.advance(runId);
      throw new WorkflowStateError(`Approval "${step}" of run ${runId} expired at ${deadline}`);
    }
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
    return this.presentApproval(runId, approver, true);
  }

  private async presentApproval(runId: string, approver: Identity, auditDenial: boolean): Promise<PendingApproval> {
    const { state, workflow } = await this.load(runId);
    if (!state.waitingOn) throw new WorkflowStateError(`Run ${runId} is not waiting on an approval`);
    const approval = this.approvalStep(workflow, state.waitingOn.step);
    await this.admitApprover(workflow, state, approval, approver, "workflow.view-approval", auditDenial);
    // What the run read, it read as the initiator: the approver sees each object only as they may read it,
    // each compute as made of what they may see, and each AI answer only if they may see all its model was given.
    const outputs = (await this.viewFor(workflow, approval, state, approver, "approver")).outputs;
    const ctx = contextFor(runId, state.input, approval, outputs);
    const presented = approval.present ? approval.present(ctx) : Object.fromEntries((approval.needs ?? []).map((n) => [n, ctx.output(n)]));
    return { runId, workflow: workflow.name, step: approval.name, policy: approval.policy, initiator: state.initiator.subjectId, presented };
  }

  /**
   * A function giving a journaled value as `viewer` may see it: every object
   * in it (a value with a string `$id` and `$type`, as the SDK returns
   * objects) is read again as the viewer, and keeps only the values that
   * read returns; an object the viewer may not read keeps only its id and
   * Type. The values kept are the journaled ones, what the run used, not
   * whatever the object holds now.
   */
  private seenBy(viewer: Identity): (value: unknown) => Promise<unknown> {
    const views = new Map<string, Promise<Record<string, unknown> | undefined>>();
    const view = (type: string, id: string) => {
      const key = `${type}\u0000${id}`;
      let v = views.get(key);
      if (!v) {
        v = this.options.host.runtime.getObject(type, id, viewer).then(
          (o) => o.values,
          () => undefined
        );
        views.set(key, v);
      }
      return v;
    };
    const redact = async (value: unknown): Promise<unknown> => {
      if (Array.isArray(value)) return Promise.all(value.map(redact));
      if (!value || typeof value !== "object") return value;
      const o = value as Record<string, unknown>;
      if (typeof o.$id === "string" && typeof o.$type === "string") {
        const seen = await view(o.$type, o.$id);
        const kept: Record<string, unknown> = { $id: o.$id, $type: o.$type };
        for (const [k, v] of Object.entries(o)) {
          if (k === "$id" || k === "$type") continue;
          if (seen && Object.hasOwn(seen, k)) kept[k] = v;
          // An included relationship: its objects are judged one by one.
          else if (seen && v && typeof v === "object") kept[k] = await redact(v);
        }
        return kept;
      }
      return Object.fromEntries(await Promise.all(Object.entries(o).map(async ([k, v]) => [k, await redact(v)] as const)));
    };
    return redact;
  }

  /**
   * Every approval waiting on someone `approver` may be: each run waiting on
   * an approval is decided for them as `pendingApproval` decides it, and
   * audited, and only the admitted ones are returned. It reads every
   * unfinished run of a workflow registered here (an index, in a journal that
   * keeps one: `PostgresWorkflowJournal`).
   */
  async approvalsFor(approver: Identity): Promise<PendingApproval[]> {
    const found: PendingApproval[] = [];
    for (const { runId, state } of (await this.ownUnfinished()).runs) {
      if (!state.waitingOn) continue;
      try {
        // A denial here is not an attempt on that run, only a listing passing it by: it is not audited, or
        // every listing by anyone would write a denial per waiting run.
        found.push(await this.presentApproval(runId, approver, false));
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

  /**
   * Resumes every unfinished run that is not waiting on a person (an
   * approval, or a re-authorization). A run that cannot be advanced does not
   * stop the others: every run is tried, then what failed is thrown together.
   */
  async resumeAll(): Promise<RunView[]> {
    return this.sweep((state) => !state.waitingOn && !state.suspended);
  }

  /**
   * Fires every durable timer that is due (ADR-0065): an approval past its
   * deadline expires and its run compensates; a retry whose backoff has
   * passed runs. Call it on a schedule, from any number of processes: two
   * that reach one run at once cannot both write (the journal's conditional
   * append), and the one that loses skips it.
   */
  async tick(): Promise<RunView[]> {
    const now = this.options.now?.() ?? new Date();
    return this.sweep((state) => !state.suspended && [...state.timers.values()].some((dueAt) => due(dueAt, now)));
  }

  /**
   * Advances every own unfinished run `select` picks, each on its own: a run
   * another process advanced first is skipped, and any other failure of one
   * run (a resolver timing out for its initiator, a journal it cannot read)
   * is collected while the rest go on, then thrown, one error or an
   * `AggregateError` of all of them.
   */
  private async sweep(select: (state: RunState) => boolean): Promise<RunView[]> {
    const views: RunView[] = [];
    const failures: unknown[] = [];
    const { runs, errors } = await this.ownUnfinished();
    failures.push(...errors);
    for (const { runId, state } of runs) {
      if (!select(state)) continue;
      try {
        views.push(await this.advance(runId));
      } catch (err) {
        if (!(err instanceof JournalConflictError)) failures.push(err);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${failures.length} runs could not be advanced`);
    return views;
  }

  /**
   * Lets a suspended run act again (ADR-0065), as `identity`: the same
   * subject the run acts as, with fresh credentials, still admitted by the
   * policy that lets them carry it. Anything else is refused and audited.
   */
  async reauthorize(runId: string, identity: Identity): Promise<RunView> {
    const { records, state, workflow } = await this.load(runId);
    if (state.finished) throw new WorkflowStateError(`Run ${runId} has finished`);
    const holder = state.authority.identity.subjectId;
    const refuse = async (reason: string): Promise<never> => {
      await this.audit(identity, "workflow.reauthorize", workflow, runId, "deny", { reason });
      throw new AuthorizationError(`Not authorized: reauthorize run ${runId}`, reason);
    };
    if (identity.subjectId !== holder) await refuse("Only the subject the run acts as may re-authorize it");
    const bound = this.keepAudience(state.authority.identity, identity);
    if (typeof bound === "string") return refuse(bound);
    const problem = this.expiry(bound) ?? (await this.authorityRefusal(workflow, state, bound));
    if (problem) await refuse(problem);
    await this.audit(bound, "workflow.reauthorize", workflow, runId, "allow", {});
    await this.writer(state, records).append({ type: "authority-restored", identity: structuredClone(bound), role: state.authority.role });
    return this.advance(runId);
  }

  /**
   * Cancels a run that has not finished: what it completed is undone, newest
   * first, and it ends `cancelled`. The initiator may always cancel their own
   * run; anyone else needs the workflow's `cancelPolicy`, and the run then
   * acts as them while it undoes, since its initiator may be the reason it
   * is being cancelled. A run suspended while undoing may be cancelled too:
   * the canceller carries the rest of the undo. An Action whose outcome was
   * never recorded (in flight, or failed in a way that says nothing of
   * whether it ran) cannot be undone with confidence: the run ends
   * `needs-reconciliation`, for a person, rather than claim a clean undo.
   */
  async cancel(runId: string, by: Identity, reason?: string): Promise<RunView> {
    const { records, state, workflow } = await this.load(runId);
    if (state.finished) throw new WorkflowStateError(`Run ${runId} has finished`);
    if (state.compensating && !state.suspended) throw new WorkflowStateError(`Run ${runId} is already being undone`);
    const own = by.subjectId === state.initiator.subjectId;
    const deny = async (why: string): Promise<never> => {
      await this.audit(by, "workflow.cancel", workflow, runId, "deny", { reason: why });
      throw new AuthorizationError(`Not authorized: cancel run ${runId}`, why);
    };
    const expired = this.expiry(by);
    if (expired) return deny(expired);
    // The initiator's own cancel keeps the audience the run reads for (ADR-0067).
    const canceller = own ? this.keepAudience(state.authority.identity, by) : by;
    if (typeof canceller === "string") return deny(canceller);
    if (!own) {
      const decision = workflow.cancelPolicy
        ? await decideForIdentity(this.options.host.policyEngine, {
            subject: by,
            action: "invoke",
            policyName: workflow.cancelPolicy,
            resource: { typeName: workflow.name, actionName: "cancel" },
            context: { runId, initiator: state.initiator.subjectId }
          })
        : { allow: false, reason: "Only the initiator may cancel a run of a workflow with no cancelPolicy" };
      if (!decision.allow) return deny(decision.reason ?? "Not admitted by the cancel policy");
      await this.audit(by, "workflow.cancel", workflow, runId, "allow", { reason: decision.reason });
    } else {
      await this.audit(by, "workflow.cancel", workflow, runId, "allow", {});
    }
    const w = this.writer(state, records);
    const unknown = workflow.steps.find(
      (step) => step.kind === "action" && ((w.state.steps.get(step.name)?.inFlight ?? false) || this.indeterminate(step, w.state))
    );
    const waiting = state.compensating?.step ?? state.waitingOn?.step ?? [...state.steps.keys()].at(-1) ?? "(start)";
    // Conditional on the journal as read above: a process that records the in-flight Action's outcome first wins, and this cancel is refused.
    await w.append(
      { type: "cancelled", by: by.subjectId, ...(reason !== undefined ? { reason } : {}) },
      // Fresh authority to undo with: the canceller's (the initiator's own, refreshed, when it is them).
      { type: "authority-restored", identity: structuredClone(canceller), role: own ? "initiator" : "canceller" },
      ...(unknown ? [] : [{ type: "compensating" as const, cause: "cancelled" as const, step: waiting }])
    );
    if (unknown?.kind === "action") {
      const view = (s: RunState) => viewOf(s, workflow.steps.map((st) => st.name));
      return view(
        await this.finish(w, workflow, "needs-reconciliation", `Cancelled while Action "${unknown.action}" of step "${unknown.name}" may have run with its outcome unrecorded: a person must check it and what else the run did`)
      );
    }
    return this.advance(runId);
  }

  /**
   * A run's progress. Given a `viewer`, only the initiator, or an approver
   * the approval it waits on admits, may see it; anyone else is told there is
   * no such run, as a missing one is. Without one, the caller is trusted (an
   * operator's console, a test).
   */
  async status(runId: string, viewer?: Identity): Promise<RunView> {
    const { state, workflow } = await this.load(runId);
    // A run's control flow encodes what it read (which branch, which steps skipped): a caller reading for an audience
    // sees only runs that read for that same audience, as with outputs (ADR-0067).
    if (viewer?.audience && viewer.audience.id !== state.initiator.audience?.id) throw new NotFoundError(`No run ${runId}`);
    if (viewer && viewer.subjectId !== state.initiator.subjectId) {
      const approval = state.waitingOn ? this.approvalStep(workflow, state.waitingOn.step) : undefined;
      const admitted = approval ? await this.admitApprover(workflow, state, approval, viewer, "workflow.view-run", false).then(() => true, () => false) : false;
      if (!admitted) throw new NotFoundError(`No run ${runId}`);
    }
    return viewOf(state, workflow.steps.map((s) => s.name));
  }

  /**
   * Every completed step's output, to the initiator only: they were read and
   * produced as them. A caller reading for an audience (ADR-0067) gets them
   * only from a run that read for that same audience: anything else the run
   * read was decided for the person alone, or for another model.
   */
  async outputs(runId: string, identity: Identity): Promise<Record<string, unknown>> {
    const { state } = await this.load(runId);
    if (identity.subjectId !== state.initiator.subjectId) throw new AuthorizationError(`Not authorized: outputs of run ${runId}`, "Only the run's initiator reads its outputs");
    if (identity.audience && identity.audience.id !== state.initiator.audience?.id) {
      throw new AuthorizationError(`Not authorized: outputs of run ${runId}`, `The run did not read for ${identity.audience.id}, so its outputs were not decided for it`);
    }
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

  private async unfinishedRuns(): Promise<string[]> {
    return this.journal.unfinished ? this.journal.unfinished() : this.journal.runs();
  }

  /**
   * The unfinished runs this engine can advance: a journal shared by several
   * services holds runs of workflows registered elsewhere, which a sweep
   * (`tick`, `resumeAll`, `approvalsFor`) leaves to their own engines.
   */
  private async ownUnfinished(): Promise<{ runs: { runId: string; state: RunState }[]; errors: unknown[] }> {
    const runs: { runId: string; state: RunState }[] = [];
    const errors: unknown[] = [];
    for (const runId of await this.unfinishedRuns()) {
      try {
        const state = fold(runId, await this.journal.read(runId));
        if (!state.finished && this.definitions.get(state.workflow)?.has(state.version)) runs.push({ runId, state });
      } catch (err) {
        // One run whose journal cannot be read or folded is that run's problem, not every run's.
        errors.push(err);
      }
    }
    return { runs, errors };
  }

  /** Why `identity` may no longer be acted on, if it has expired. */
  private expiry(identity: Identity): string | undefined {
    if (identity.expiresAt === undefined) return undefined;
    const at = Date.parse(identity.expiresAt);
    const now = (this.options.now?.() ?? new Date()).getTime();
    return Number.isNaN(at) || at <= now ? `The credentials of ${identity.subjectId} expired at ${identity.expiresAt}` : undefined;
  }

  /**
   * Why `identity` may not carry this run any more, if it may not: the start
   * policy for the initiator, the cancel policy for a canceller. While a run
   * only undoes what it did, no workflow policy applies: each compensating
   * Action is decided by the runtime on its own policy.
   */
  private async authorityRefusal(workflow: AnyWorkflow, state: RunState, identity: Identity): Promise<string | undefined> {
    if (state.compensating) return undefined;
    const policyName = state.authority.role === "canceller" ? workflow.cancelPolicy : workflow.startPolicy;
    if (!policyName) return "No policy admits a canceller to carry this run";
    const decision = await decideForIdentity(this.options.host.policyEngine, {
      subject: identity,
      action: "invoke",
      policyName,
      resource: { typeName: workflow.name, actionName: state.authority.role === "canceller" ? "cancel" : "start" },
      context: { runId: state.runId, initiator: state.initiator.subjectId }
    });
    return decision.allow ? undefined : `${identity.subjectId} is no longer admitted by "${policyName}"${decision.reason ? `: ${decision.reason}` : ""}`;
  }

  /**
   * The identity the run may act as now (ADR-0065), or `undefined` with the
   * run suspended: re-resolved when the host can, never older than
   * `identityMaxAgeMs` when it cannot, never expired, the same subject, and
   * still admitted by the policy that lets it carry the run.
   */
  private async currentAuthority(w: RunWriter, workflow: AnyWorkflow): Promise<Identity | undefined> {
    if (w.state.suspended) return undefined;
    const { identity: held, at } = w.state.authority;
    let current = held;
    if (this.options.resolveIdentity) {
      try {
        current = await this.options.resolveIdentity(structuredClone(held));
      } catch (err) {
        if (!(err instanceof AuthorizationError || err instanceof NotFoundError)) throw err;
        return this.suspend(w, workflow, `${held.subjectId} could not be re-resolved: ${err.message}`);
      }
    } else {
      const age = (this.options.now?.() ?? new Date()).getTime() - Date.parse(at);
      const max = this.options.identityMaxAgeMs ?? DEFAULT_IDENTITY_MAX_AGE_MS;
      // Fails closed: an age or a limit that is not a number (NaN) does not pass.
      if (!(age <= max)) return this.suspend(w, workflow, `The identity this run acts as is ${Math.round(age / 1000)}s old, past the ${Math.round(max / 1000)}s it may be used without being re-resolved`);
    }
    if (current.subjectId !== held.subjectId) return this.suspend(w, workflow, `${held.subjectId} re-resolved as a different subject`);
    // A directory returns the person: the run still reads for the audience it was started for (ADR-0067).
    const bound = this.keepAudience(held, current);
    if (typeof bound === "string") return this.suspend(w, workflow, bound);
    return this.stillAuthorized(w, workflow, bound);
  }

  /**
   * `fresh`, reading for the audience `held` reads for (ADR-0067); or why it
   * cannot, when `fresh` reads for another one.
   */
  private keepAudience(held: Identity, fresh: Identity): Identity | string {
    if (!held.audience) return fresh;
    if (fresh.audience && fresh.audience.id !== held.audience.id) return `The run reads for ${held.audience.id}; ${fresh.subjectId} now reads for ${fresh.audience.id}`;
    // The run's own audience, never one the resolver supplied under the same id.
    return { ...fresh, audience: held.audience };
  }

  /** `identity`, if it has not expired and still carries the run; otherwise the run is suspended. Checked before every step. */
  private async stillAuthorized(w: RunWriter, workflow: AnyWorkflow, identity: Identity): Promise<Identity | undefined> {
    const problem = this.expiry(identity) ?? (await this.authorityRefusal(workflow, w.state, identity));
    return problem ? this.suspend(w, workflow, problem) : identity;
  }

  private async suspend(w: RunWriter, workflow: AnyWorkflow, reason: string): Promise<undefined> {
    await w.append({ type: "authority-suspended", reason });
    await this.audit(w.state.authority.identity, "workflow.authority", workflow, w.state.runId, "deny", { reason });
    return undefined;
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
    operation: string,
    auditDenial = true
  ): Promise<void> {
    // Credentials that have expired decide nothing, here as for cancel and reauthorize.
    const expired = this.expiry(approver);
    if (expired) {
      if (auditDenial) await this.audit(approver, operation, workflow, state.runId, "deny", { step: step.name, reason: expired });
      throw new AuthorizationError(`Not authorized: ${operation} ${workflow.name}/${step.name}`, expired);
    }
    if (!step.allowSelfApproval && approver.subjectId === state.initiator.subjectId) {
      const reason = "The initiator of a run may not approve it";
      if (auditDenial) await this.audit(approver, operation, workflow, state.runId, "deny", { step: step.name, reason });
      throw new AuthorizationError(`Not authorized: ${operation} ${workflow.name}/${step.name}`, reason);
    }
    const decision = await decideForIdentity(this.options.host.policyEngine, {
      subject: approver,
      action: "invoke",
      policyName: step.policy,
      resource: { typeName: workflow.name, actionName: step.name },
      context: { runId: state.runId, initiator: state.initiator.subjectId }
    });
    if (decision.allow || auditDenial) await this.audit(approver, operation, workflow, state.runId, decision.allow ? "allow" : "deny", { step: step.name, reason: decision.reason });
    if (!decision.allow) throw new AuthorizationError(`Not authorized: ${operation} ${workflow.name}/${step.name}`, decision.reason);
  }

  private async audit(
    who: Identity,
    action: string,
    workflow: AnyWorkflow,
    runId: string,
    decision: "allow" | "deny",
    extra: { step?: string; reason?: string | undefined; outcome?: "success" | "failure"; status?: string; audience?: string; withheld?: readonly string[] }
  ): Promise<void> {
    await this.options.host.registry.appendAuditEvent({
      id: randomUUID(),
      timestamp: this.now(),
      subjectId: who.subjectId,
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
        // The audience a row's subject reads for (ADR-0067); a release names the model's, and what it withheld.
        ...(extra.audience ? { audience: extra.audience, withheld: extra.withheld ?? [] } : who.audience ? { audience: who.audience.id } : {}),
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
    const now = () => this.options.now?.() ?? new Date();
    // An approval that missed its deadline expires before anything else, even for a suspended run.
    const waiting = w.state.waitingOn?.step;
    if (waiting && !w.state.compensating && due(w.state.timers.get(`approval:${waiting}`), now())) {
      await w.append({ type: "approval-expired", step: waiting }, { type: "compensating", cause: "expired", step: waiting });
    }
    if (w.state.waitingOn) return view(w.state);
    const identity = await this.currentAuthority(w, workflow);
    if (!identity) return view(w.state);

    if (!w.state.compensating) {
      for (const step of workflow.steps) {
        const s = w.state.steps.get(step.name);
        if (s?.outcome?.kind === "completed" || s?.outcome?.kind === "skipped") continue;
        if (s?.outcome?.kind === "failed") {
          if (this.indeterminate(step, w.state)) {
            return view(
              await this.finish(w, workflow, "needs-reconciliation", `Action "${step.action}" of step "${step.name}" may have run: it failed with a retryable error, and it is not idempotent`)
            );
          }
          // Failed before a restart, with its compensation not yet begun.
          await w.append({ type: "compensating", cause: "failed", step: step.name });
          break;
        }
        const ctx = contextFor(runId, w.state.input, step, outputsOf(w.state));
        if (!s && step.when && !reviewsAiOutput(workflow, step, w.state) && !step.when(ctx)) {
          await w.append({ type: "step-skipped", step: step.name });
          continue;
        }
        if (step.kind === "approval") {
          const decision = s?.approval?.decision;
          if (!decision) {
            if (!s?.approval?.requested) {
              await w.append(
                { type: "approval-requested", step: step.name, policy: step.policy },
                ...(step.deadline ? [{ type: "timer-set" as const, timer: `approval:${step.name}`, dueAt: new Date(now().getTime() + step.deadline.afterMs).toISOString() }] : [])
              );
            }
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
        // A retry backing off on a durable timer waits until it is due.
        const backoff = w.state.timers.get(`retry:${step.name}`);
        if (backoff !== undefined && !due(backoff, now())) return view(w.state);
        // Authority is checked again before every step: a policy change or an expiry between steps stops the run here.
        if (!(await this.stillAuthorized(w, workflow, identity))) return view(w.state);
        const attempted = await this.attempt(w, workflow, step, ctx, identity);
        if (attempted === "waiting") return view(w.state);
        if (!attempted) {
          // A retryable error (a timeout, a dropped connection) says the outcome is unknown, not that nothing
          // happened: for an Action that is not idempotent, the write may have landed, so a person reconciles it.
          if (this.indeterminate(step, w.state)) {
            return view(
              await this.finish(w, workflow, "needs-reconciliation", `Action "${step.action}" of step "${step.name}" may have run: it failed with a retryable error, and it is not idempotent`)
            );
          }
          await w.append({ type: "compensating", cause: "failed", step: step.name });
          break;
        }
      }
      if (!w.state.compensating) return view(await this.finish(w, workflow, "completed"));
    }
    return view(await this.compensate(w, workflow, identity));
  }

  /** A failed Action step whose outcome is unknown: it is not idempotent, and its last error was retryable (a timeout after the write, say). */
  private indeterminate(step: AnyStep, state: RunState): step is Extract<AnyStep, { kind: "action" }> {
    const outcome = state.steps.get(step.name)?.outcome;
    return step.kind === "action" && outcome?.kind === "failed" && outcome.retryable && this.actions.get(step.action)!.idempotency === "none";
  }

  /** Runs one step, retrying what may be retried. True when it completed; `"waiting"` when a retry backs off on a durable timer. */
  private async attempt(w: RunWriter, workflow: AnyWorkflow, step: AnyStep, ctx: StepContext, identity: Identity): Promise<boolean | "waiting"> {
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    const models = step.kind === "ai" && this.options.model ? [this.options.model, ...(this.options.model.fallbacks ?? [])] : [];
    const first = (w.state.steps.get(step.name)?.attempts ?? 0) + 1;
    for (let attempt = first; ; attempt++) {
      // A retry after an in-process backoff is checked again: credentials may have expired while it waited.
      if (attempt > first && !(await this.stillAuthorized(w, workflow, identity))) return "waiting";
      let input: unknown;
      let released: { audience: string; needs: Record<string, unknown> } | undefined;
      // The model this attempt asks: the engine's, then each fallback in turn while the one before is unavailable (ADR-0075).
      let candidate = 0;
      try {
        if (step.kind === "action") input = step.input(ctx);
        if (step.kind === "ai") ({ input, released } = await this.releaseInput(workflow, step, w.state, ctx, identity, models[0]!));
      } catch (err) {
        const retryable = isRetryable(err);
        await w.append({ type: "step-failed", step: step.name, attempt, error: recorded(err), retryable, final: !retryable || attempt >= maxAttempts });
        if (!retryable || attempt >= maxAttempts) return false;
        continue;
      }
      await w.append({
        type: "step-started",
        step: step.name,
        attempt,
        ...(step.kind === "action" ? { action: step.action, input } : step.kind === "ai" ? { input, ...(released ? { released } : {}) } : {})
      });
      const fault = this.faults(step.name, attempt);
      let lastErr: unknown;
      try {
        if (fault?.crash === "before-effect") throw new SimulatedCrash(step.name, "before-effect");
        if (fault?.error) throw fault.error;
        for (;;) {
          try {
            const result = await this.effect(workflow, step, ctx, input, identity, w.state, models[candidate]);
            if (fault?.crash === "after-effect") throw new SimulatedCrash(step.name, "after-effect");
            await w.append({ type: "step-completed", step: step.name, attempt, ...result });
            return true;
          } catch (err) {
            if (err instanceof SimulatedCrash || step.kind !== "ai" || !modelUnavailable(err)) throw err;
            lastErr = err;
            // The next fallback this step's input may be released to, deciding each one's release on its own.
            let next: { input: unknown; released: { audience: string; needs: Record<string, unknown> } } | undefined;
            while (!next && ++candidate < models.length) {
              const m = models[candidate]!;
              await w.append({ type: "step-failed", step: step.name, attempt, error: recorded(err), retryable: true, final: false });
              try {
                next = await this.releaseInput(workflow, step, w.state, ctx, identity, m);
              } catch (refusal) {
                if (!(refusal instanceof ReleaseRefusedError)) throw refusal;
              }
            }
            if (!next) throw lastErr;
            await this.audit(identity, "workflow.fallback", workflow, w.state.runId, "allow", { step: step.name, reason: `${models[candidate - 1]!.id} failed: ${recorded(err).message}`, audience: next.released.audience });
            ({ input, released } = next);
            await w.append({ type: "step-started", step: step.name, attempt, input, released, model: models[candidate]!.id });
          }
        }
      } catch (err) {
        if (err instanceof SimulatedCrash) throw err;
        const retryable = isRetryable(err);
        const final = !retryable || attempt >= maxAttempts;
        await w.append({ type: "step-failed", step: step.name, attempt, error: recorded(err), retryable, final });
        if (final) return false;
        const delay = (step.retry?.backoffMs ?? 0) * 2 ** (attempt - 1);
        if (delay > 0) {
          const dueAt = new Date((this.options.now?.() ?? new Date()).getTime() + delay).toISOString();
          await w.append({ type: "timer-set", timer: `retry:${step.name}`, dueAt });
          if (delay > (this.options.inlineWaitMs ?? DEFAULT_INLINE_WAIT_MS)) return "waiting";
          await (this.options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
        }
      }
    }
  }

  private async effect(
    workflow: AnyWorkflow,
    step: AnyStep,
    ctx: StepContext,
    input: unknown,
    identity: Identity,
    state: RunState,
    aiModel?: AiModel
  ): Promise<{ output: unknown; source: OutputSource; model?: string; simulated?: { wouldExecute: boolean | null; note?: string } }> {
    switch (step.kind) {
      case "read": {
        // A read step reads: it gets no way to invoke an Action, which would bypass the AI-review rule, the
        // journal's no-replay guarantee for non-idempotent Actions, and a simulation's promise to change nothing.
        const client = createClient<ModelShape>(readOnlyTransport(runtimeTransport(this.options.host.runtime, identity), step.name));
        return { output: structuredClone(await step.run(client, ctx)), source: "read" };
      }
      case "compute":
        return { output: structuredClone(step.run(ctx)), source: "compute" };
      case "ai": {
        const model = aiModel ?? this.options.model;
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

  /**
   * What an AI step may send its model (ADR-0067). The step's upstream reads
   * are run again, and its computes recomputed, as the person carrying the
   * run bound to the model's audience, so the runtime decides every value for
   * both; model answers and approvals pass as journaled, and nothing an
   * Action returned may reach a model (registration refuses it). Whether each
   * upstream step runs is decided again too, its `when` on what the model may
   * receive, since a condition over a withheld value is that value's bit.
   * The input is then built from those outputs. If it differs from what the
   * person alone would have sent, the step is refused unless it opts into
   * redaction. An AI step whose own `when` holds only on what the model may
   * not receive is refused either way. Every release is audited, with the
   * audience and what was withheld.
   */
  private async releaseInput(
    workflow: AnyWorkflow,
    step: Extract<AnyStep, { kind: "ai" }>,
    state: RunState,
    ctx: StepContext,
    identity: Identity,
    model: AiModel
  ): Promise<{ input: unknown; released: { audience: string; needs: Record<string, unknown> } }> {
    const audience = audienceOf(model);
    const refuse = async (message: string, withheld: string[]): Promise<never> => {
      await this.audit(identity, "workflow.release", workflow, state.runId, "deny", { step: step.name, reason: message, audience: audience.id, withheld });
      throw new ReleaseRefusedError(message, audience.id, withheld);
    };
    if (identity.audience && identity.audience.id !== audience.id) {
      return refuse(`The run reads for ${identity.audience.id}; its AI step "${step.name}" cannot also release to ${audience.id}`, []);
    }
    const view = await this.viewFor(workflow, step, state, withAudience(identity, audience));
    const original = outputsOf(state);
    const withheld = (step.needs ?? []).filter((n) => canonical(view.outputs.get(n)) !== canonical(original.get(n)));
    if (!view.holds) {
      return refuse(`AI step "${step.name}" runs only because of data ${audience.id} may not receive (from ${withheld.join(", ") || "its needs"}): its when does not hold on what it may`, withheld);
    }
    const input = step.input(view.ctx);
    const needs = Object.fromEntries((step.needs ?? []).map((n) => [n, view.outputs.get(n)]));
    if (canonical(input) !== canonical(step.input(ctx))) {
      if ((step.release ?? "refuse") === "refuse") {
        await refuse(`AI step "${step.name}" would send ${audience.id} data it may not receive (from ${withheld.join(", ") || "its needs"}); declare release: "redact" to send only what it may`, withheld);
      }
    }
    await this.audit(identity, "workflow.release", workflow, state.runId, "allow", { step: step.name, audience: audience.id, withheld });
    return { input, released: { audience: audience.id, needs } };
  }

  /**
   * The run's outputs upstream of `step` as `as` may receive them, and
   * whether `step`'s own `when` holds on them (ADR-0067): reads run again as
   * `as`, computes recomputed, each step's `when` decided again on what `as`
   * may see, and earlier AI answers passed only where `as` may receive what
   * their model was given (ADR-0075). `as` is the person bound to a model's
   * audience for a release, or an approver for what they are shown.
   */
  private async viewFor(
    workflow: AnyWorkflow,
    step: AnyStep,
    state: RunState,
    as: Identity,
    purpose: "release" | "approver" = "release"
  ): Promise<{ outputs: Map<string, unknown>; ctx: StepContext; holds: boolean }> {
    const original = outputsOf(state);
    const redact = purpose === "approver" ? this.seenBy(as) : undefined;
    const outputs = new Map<string, unknown>();
    const closure = upstream(workflow.steps, step.name);
    const holds = (s: AnyStep, sctx: StepContext): boolean => {
      if (!s.when || reviewsAiOutput(workflow, s, state)) return true;
      try {
        return Boolean(s.when(sctx));
      } catch {
        // A condition that fails without a withheld value does not hold for the model.
        return false;
      }
    };
    for (const s of workflow.steps) {
      if (!closure.has(s.name)) continue;
      const sctx = contextFor(state.runId, state.input, s, outputs);
      // The view decides whether the step ran: a step the person's data skipped and this view's would run is run again as this view sees it.
      outputs.set(s.name, holds(s, sctx) ? await this.releasedOutput(workflow, s, sctx, original.get(s.name), as, state, redact) : undefined);
    }
    const ctx = contextFor(state.runId, state.input, step, outputs);
    return { outputs, ctx, holds: holds(step, ctx) };
  }

  /**
   * One upstream step's output as `releaseAs` may receive it: `undefined`
   * where the runtime refuses it. With `redact` (an approver's view), what a
   * read or an Action returned is the journaled value as the approver may
   * see it; for a release to a model, reads run again as its audience and
   * Action results are not sent.
   */
  private async releasedOutput(
    workflow: AnyWorkflow,
    s: AnyStep,
    ctx: StepContext,
    journaled: unknown,
    releaseAs: Identity,
    state: RunState,
    redact?: (value: unknown) => Promise<unknown>
  ): Promise<unknown> {
    const refused = (err: unknown) => err instanceof AuthorizationError || err instanceof NotFoundError;
    switch (s.kind) {
      case "read": {
        if (redact) return redact(journaled);
        const client = createClient<ModelShape>(readOnlyTransport(runtimeTransport(this.options.host.runtime, releaseAs), s.name));
        try {
          return structuredClone(await s.run(client, ctx));
        } catch (err) {
          if (refused(err)) return undefined;
          throw err;
        }
      }
      case "compute":
        try {
          return structuredClone(s.run(ctx));
        } catch {
          // A compute over a withheld value may fail; what it would have made of the full value is withheld too.
          return undefined;
        }
      case "ai": {
        // A model's answer is made of what its model was given (ADR-0075): it passes to whoever may receive all of that.
        const given = state.steps.get(s.name)?.released;
        if (!given || journaled === undefined) return undefined;
        if (releaseAs.audience && given.audience === releaseAs.audience.id) return journaled;
        const view = await this.viewFor(workflow, s, state, releaseAs, redact ? "approver" : "release");
        const needs = Object.fromEntries((s.needs ?? []).map((n) => [n, view.outputs.get(n)]));
        return view.holds && covers(needs, given.needs) ? journaled : undefined;
      }
      case "approval":
        return journaled;
      case "action":
        return redact && journaled !== undefined ? redact(journaled) : undefined;
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
      if (!(await this.stillAuthorized(w, workflow, identity))) return w.state;
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
    const reasons: Record<CompensationCause, () => string> = {
      rejected: () => `Approval "${cause.step}" was rejected by ${s?.approval?.decision?.approver ?? "an approver"}`,
      expired: () => `Approval "${cause.step}" expired with no decision`,
      cancelled: () => `Cancelled by ${w.state.cancelled?.by ?? "someone"}${w.state.cancelled?.reason ? `: ${w.state.cancelled.reason}` : ""}`,
      failed: () => `Step "${cause.step}" failed: ${s?.outcome?.kind === "failed" ? `${s.outcome.error.name}: ${s.outcome.error.message}` : "unknown error"}`
    };
    const status: Record<CompensationCause, FinalStatus> = { rejected: "rejected", expired: "rejected", cancelled: "cancelled", failed: "failed" };
    return this.finish(w, workflow, status[cause.cause], reasons[cause.cause]());
  }

  private async finish(w: RunWriter, workflow: AnyWorkflow, status: FinalStatus, reason?: string): Promise<RunState> {
    await w.append({ type: "run-finished", status, ...(reason !== undefined ? { reason } : {}) });
    await this.audit(w.state.initiator, "workflow.finish", workflow, w.state.runId, "allow", {
      outcome: status === "completed" ? "success" : "failure",
      status,
      reason
    });
    return w.state;
  }
}

/** A transport for read steps: everything reads, and invoking an Action is refused. */
function readOnlyTransport(inner: Transport, step: string): Transport {
  return {
    ...inner,
    invokeAction: async (action) => {
      throw new WorkflowDefinitionError(`Read step "${step}" tried to invoke Action "${action}": only an action step may, so it is reviewed, journaled and simulated`);
    }
  };
}

/**
 * Whether `seen` holds all of `given`: every value in `given` is in `seen`,
 * equal, at the same place. Who may see everything a model was given may
 * see its answer, even when they may see more than the model was given.
 */
function covers(seen: unknown, given: unknown): boolean {
  if (given === undefined) return true;
  if (Array.isArray(given)) return Array.isArray(seen) && seen.length === given.length && given.every((g, i) => covers(seen[i], g));
  if (given && typeof given === "object") {
    if (!seen || typeof seen !== "object" || Array.isArray(seen)) return false;
    return Object.entries(given as Record<string, unknown>).every(([k, g]) => Object.hasOwn(seen, k) && covers((seen as Record<string, unknown>)[k], g));
  }
  return canonical(seen) === canonical(given);
}
