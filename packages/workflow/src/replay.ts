import { canonical } from "@typesys/core";
import type { AnyStep, AnyWorkflow, StepContext } from "./definition.js";
import { ReplayDivergenceError, WorkflowDefinitionError } from "./errors.js";
import type { JournalRecord, OutputSource } from "./journal.js";
import { fold, type RunState } from "./state.js";

export { canonical };

const SOURCE: Record<AnyStep["kind"], OutputSource> = { read: "read", compute: "compute", ai: "model", approval: "human", action: "action" };

/** The outputs the journal holds: a completed step's output, and `undefined` for a skipped one. */
export function outputsOf(state: RunState): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  for (const [name, s] of state.steps) {
    if (s.outcome?.kind === "completed") outputs.set(name, s.outcome.output);
    if (s.outcome?.kind === "skipped") outputs.set(name, undefined);
  }
  return outputs;
}

/** A step's context: the run's input and its declared needs, and a refusal for anything else. */
export function contextFor(runId: string, input: unknown, step: AnyStep, outputs: ReadonlyMap<string, unknown>): StepContext {
  const needs = new Set(step.needs ?? []);
  return {
    runId,
    input,
    idempotencyKey: `${runId}:${step.name}`,
    output: <T>(name: string): T | undefined => {
      if (!needs.has(name)) throw new WorkflowDefinitionError(`step "${step.name}" read the output of "${name}", which it does not declare in needs`);
      return structuredClone(outputs.get(name)) as T | undefined;
    }
  };
}

/**
 * Checks that `workflow` reproduces everything the run's journal recorded
 * (ADR-0057): the same steps, of the same kinds, skipped or run as before,
 * every compute step returning what it returned then, and every Action and AI
 * step given the same input. Reads, model answers, approvals and Action
 * outputs are taken from the journal, never repeated. The engine runs this
 * before it advances any run, so a definition that changed incompatibly
 * cannot resume a run under different logic; run it in CI against recorded
 * journals before deploying a new version.
 */
export function verifyReplay(workflow: AnyWorkflow, state: RunState): void {
  const outputs = outputsOf(state);
  const known = new Set(workflow.steps.map((s) => s.name));
  for (const name of state.steps.keys()) {
    if (!known.has(name)) throw new ReplayDivergenceError(name, "the journal records a step the definition does not have");
  }
  for (const step of workflow.steps) {
    const recorded = state.steps.get(step.name);
    if (!recorded) break; // Nothing was recorded from here on, so there is nothing to reproduce.
    const ctx = contextFor(state.runId, state.input, step, outputs);
    const evaluate = <T>(what: string, f: () => T): T => {
      try {
        return f();
      } catch (err) {
        throw new ReplayDivergenceError(step.name, `${what} now throws: ${(err as Error).message}`);
      }
    };
    const runs = step.when ? evaluate("when", () => step.when!(ctx)) : true;
    if (recorded.outcome?.kind === "skipped") {
      if (runs) throw new ReplayDivergenceError(step.name, "it was skipped, and would now run");
      continue;
    }
    if (!runs) throw new ReplayDivergenceError(step.name, "it ran, and would now be skipped");
    if (recorded.outcome?.kind === "completed" && recorded.outcome.source !== SOURCE[step.kind]) {
      throw new ReplayDivergenceError(step.name, `it was a ${recorded.outcome.source} step, and is now a ${step.kind} step`);
    }
    if (step.kind === "compute" && recorded.outcome?.kind === "completed") {
      const now = evaluate("run", () => step.run(ctx));
      if (canonical(now) !== canonical(recorded.outcome.output)) throw new ReplayDivergenceError(step.name, "it now computes a different output");
    }
    if (step.kind === "action" && recorded.action !== undefined) {
      if (recorded.action !== step.action) throw new ReplayDivergenceError(step.name, `it invoked "${recorded.action}", and would now invoke "${step.action}"`);
      if (canonical(evaluate("input", () => step.input(ctx))) !== canonical(recorded.input)) {
        throw new ReplayDivergenceError(step.name, "it would now invoke its Action with a different input");
      }
    }
    if (step.kind === "ai" && recorded.attempts > 0 && canonical(evaluate("input", () => step.input(ctx))) !== canonical(recorded.input)) {
      throw new ReplayDivergenceError(step.name, "it would now give the model a different input");
    }
  }
}

/** `verifyReplay` over a journal read back from a store, for a CI check of a new definition against recorded runs. */
export function replay(workflow: AnyWorkflow, runId: string, records: readonly JournalRecord[]): void {
  const state = fold(runId, records);
  if (state.workflow !== workflow.name) throw new ReplayDivergenceError("(run)", `the journal is of workflow "${state.workflow}", not "${workflow.name}"`);
  verifyReplay(workflow, state);
}
