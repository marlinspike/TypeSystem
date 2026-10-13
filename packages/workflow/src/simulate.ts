import { AuthorizationError, describeModel, type ActionDescription, type Identity, type ModelDescription } from "@typesys/core";
import { synthesize } from "@typesys/devkit";
import type { ModelShape } from "@typesys/sdk";
import { scriptedModel } from "./ai.js";
import type { WorkflowDefinition } from "./definition.js";
import { WorkflowEngine, type FaultPlan, type WorkflowEngineOptions, type WorkflowHost } from "./engine.js";
import { SimulatedCrash, SimulationError } from "./errors.js";
import { InMemoryJournal, type JournalRecord } from "./journal.js";
import type { RunView } from "./state.js";

export interface SimulationScript<I = unknown> {
  readonly initiator: Identity;
  readonly input: I;
  /** Each AI step's answer, or a function of the request (`AiRequest`). A step with no answer fails, as a model outage would. */
  readonly ai?: Readonly<Record<string, unknown>>;
  /** Each approval's decision and who makes it; the approver's policy is decided for real. Unscripted, the run stops there. */
  readonly approvals?: Readonly<Record<string, { readonly approver: Identity; readonly approved: boolean; readonly comment?: string }>>;
  readonly faults?: FaultPlan;
  /** Seeds the synthetic Action outputs. Default 1. */
  readonly seed?: number;
}

export interface SimulationResult {
  readonly run: RunView;
  /** The run's journal, which is its trace: every step, attempt, input, output and decision, in order. */
  readonly trace: readonly JournalRecord[];
  /** Approvals the script asked for that the policy refused (the run stays waiting at the first). */
  readonly refusals: readonly { readonly step: string; readonly message: string }[];
  /** Injected crashes, each followed by a resume from the journal. */
  readonly crashes: readonly string[];
}

/** Strings in a value, so an id the simulation invented can be recognized when a later step names it. */
function strings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, into));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, into));
}

class SimulationEngine extends WorkflowEngine {
  protected override readonly simulation = true;
  private readonly invented = new Set<string>();
  private seed: number;

  constructor(
    options: WorkflowEngineOptions,
    model: ModelDescription,
    seed: number
  ) {
    super(options, model);
    this.seed = seed;
  }

  /**
   * Previews instead of invoking (ADR-0053): authorization, input and
   * preconditions are decided for real, and nothing executes. The output is
   * synthesized from the Action's output schema, echoing the input's values
   * where the output names them. A target the simulation itself invented
   * cannot be checked, and is reported as such rather than as a pass.
   */
  protected override async invokeAction(action: ActionDescription, input: unknown, identity: Identity) {
    const preview = await this.options.host.runtime.previewAction(action.name, input, identity);
    const targetId = action.target ? (input as Record<string, unknown> | null)?.[action.target.idFrom] : undefined;
    const inventedTarget = typeof targetId === "string" && this.invented.has(targetId);
    const onlyInventedTarget = !preview.wouldExecute && inventedTarget && preview.blockers.every((b) => b.kind === "target");
    if (!preview.wouldExecute && !onlyInventedTarget) {
      throw new SimulationError(`${action.name} would not execute: ${preview.blockers.map((b) => `${b.kind}: ${b.message}`).join("; ")}`);
    }
    const synthesized = synthesize(action.outputSchema, this.seed++);
    const output =
      synthesized && typeof synthesized === "object" && !Array.isArray(synthesized) && input && typeof input === "object"
        ? Object.fromEntries(Object.entries(synthesized).map(([k, v]) => [k, k in input ? (input as Record<string, unknown>)[k] : v]))
        : synthesized;
    strings(output, this.invented);
    return {
      output,
      simulated: onlyInventedTarget
        ? { wouldExecute: null, note: "its target was invented earlier in this simulation, so the preview could not check it" }
        : { wouldExecute: true }
    };
  }
}

/**
 * Runs a workflow without changing anything (ADR-0057). Reads go to the
 * runtime as the initiator, exactly as in a live run; Actions are previewed,
 * never invoked; the model's answers and the approvers' decisions come from
 * the script, while each approver is still decided by the real policy. Faults
 * inject errors and crashes; after a crash the run resumes from its journal,
 * as a restarted process would. The result is the run and its full trace.
 */
export async function simulate<M extends ModelShape, I>(host: WorkflowHost, workflow: WorkflowDefinition<M, I>, script: SimulationScript<I>): Promise<SimulationResult> {
  const engine = new SimulationEngine(
    { host, journal: new InMemoryJournal(), model: scriptedModel(script.ai ?? {}, "simulation-script"), ...(script.faults ? { faults: script.faults } : {}), sleep: async () => {} },
    await describeModel(host.registry),
    script.seed ?? 1
  );
  engine.register(workflow);
  const crashes: string[] = [];
  const refusals: { step: string; message: string }[] = [];
  const recover = async (run: () => Promise<RunView>, runId?: () => Promise<string>): Promise<RunView> => {
    for (;;) {
      try {
        return await run();
      } catch (err) {
        if (!(err instanceof SimulatedCrash) || crashes.length >= 10) throw err;
        crashes.push(err.message);
        const id = await runId!();
        run = () => engine.resume(id);
      }
    }
  };
  const latestRun = async () => (await engine.journal.runs())[0]!;
  let view = await recover(() => engine.start(workflow.name, script.input, script.initiator), latestRun);
  while (view.status === "waiting-approval") {
    const step = view.waitingOn!.step;
    const decision = script.approvals?.[step];
    if (!decision) break;
    try {
      const runId = view.runId;
      view = await recover(() => engine.approve(runId, step, decision.approver, decision), async () => runId);
    } catch (err) {
      if (!(err instanceof AuthorizationError)) throw err;
      refusals.push({ step, message: err.reason ?? err.message });
      break;
    }
  }
  return { run: view, trace: await engine.trace(view.runId), refusals, crashes };
}
