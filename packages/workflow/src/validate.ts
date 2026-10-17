import { createSemanticValidator, type JsonSchema2020, type ModelDescription } from "@typesys/core";
import type { AnyStep, AnyWorkflow } from "./definition.js";
import type { WorkflowDiagnostic } from "./errors.js";

const STEP_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const WORKFLOW_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** Every step `name` reads from, directly or through the steps it reads from. */
export function upstream(steps: readonly AnyStep[], name: string): Set<string> {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const stack = [...(byName.get(name)?.needs ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byName.get(next)?.needs ?? []));
  }
  return seen;
}

/**
 * Checks a workflow against the model before any run (ADR-0057). The rule
 * that matters most: an AI step's output may reach an Action with side
 * effects only through an approval that also depends on that AI step, so a
 * person the policy admits has seen what the model proposed before anything
 * changes. `needs` is a step's whole data flow (the engine refuses any other
 * read), so following `needs` is following the data.
 */
export function validateWorkflow(workflow: AnyWorkflow, model: ModelDescription): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const add = (d: WorkflowDiagnostic) => diagnostics.push(d);
  const actions = new Map(model.actions.map((a) => [a.name, a]));
  const ajv = createSemanticValidator();
  const compiles = (schema: JsonSchema2020, step: string | undefined, what: string) => {
    try {
      ajv.compile(schema);
    } catch (err) {
      add({ code: "invalid-schema", ...(step ? { step } : {}), message: `${what} is not a valid schema: ${(err as Error).message}` });
    }
  };

  if (!WORKFLOW_NAME.test(workflow.name)) add({ code: "invalid-name", message: `workflow name "${workflow.name}" must be qualified, like a Type (domain.Name)` });
  if (!workflow.startPolicy) add({ code: "missing-policy", message: "the workflow names no startPolicy" });
  compiles(workflow.inputSchema, undefined, "inputSchema");
  if (workflow.about) {
    if (!model.types.some((t) => t.name === workflow.about!.type)) add({ code: "unknown-type", message: `the workflow is about unknown Type "${workflow.about.type}"` });
    if (!Object.hasOwn((workflow.inputSchema.properties ?? {}), workflow.about.idFrom)) add({ code: "unknown-need", message: `the workflow is about the input "${workflow.about.idFrom}", which its inputSchema does not declare` });
  }

  const earlier = new Set<string>();
  for (const step of workflow.steps) {
    if (!STEP_NAME.test(step.name)) add({ code: "invalid-name", step: step.name, message: `step name "${step.name}" must match ${STEP_NAME.source}` });
    if (earlier.has(step.name)) add({ code: "duplicate-step", step: step.name, message: `step "${step.name}" is defined twice` });
    for (const need of step.needs ?? []) {
      if (!earlier.has(need)) add({ code: "unknown-need", step: step.name, message: `step "${step.name}" needs "${need}", which is not an earlier step` });
    }
    if (step.retry && (!Number.isInteger(step.retry.maxAttempts) || step.retry.maxAttempts < 1 || (step.retry.backoffMs ?? 0) < 0)) {
      add({ code: "invalid-retry", step: step.name, message: `step "${step.name}" has an invalid retry policy` });
    }
    if (step.kind === "ai") {
      compiles(step.outputSchema, step.name, `step "${step.name}" outputSchema`);
      // An Action's output cannot be re-read as the model's audience, so nothing an Action returned may reach a model (ADR-0067).
      for (const up of upstream(workflow.steps, step.name)) {
        if (workflow.steps.find((s) => s.name === up)?.kind === "action") {
          add({ code: "unreleasable-ai-input", step: step.name, message: `AI step "${step.name}" depends on the output of Action step "${up}", which cannot be released to a model: read what the model needs in a read step` });
        }
      }
    }
    if (step.kind === "read") {
      const types = new Set(model.types.map((t) => t.name));
      for (const t of step.reads ?? []) if (!types.has(t)) add({ code: "unknown-type", step: step.name, message: `read step "${step.name}" declares it reads unknown Type "${t}"` });
    }
    if (step.kind === "approval" && !step.policy) add({ code: "missing-policy", step: step.name, message: `approval "${step.name}" names no policy` });
    // A deadline is a time to come: NaN or Infinity would journal a timer no clock can reach, and zero or less expires at once.
    if (step.kind === "approval" && step.deadline !== undefined && !(Number.isFinite(step.deadline.afterMs) && step.deadline.afterMs > 0)) {
      add({ code: "invalid-deadline", step: step.name, message: `approval "${step.name}" has a deadline that is not a positive, finite number of milliseconds` });
    }
    if (step.kind === "action") {
      const action = actions.get(step.action);
      if (!action) add({ code: "unknown-action", step: step.name, message: `step "${step.name}" invokes unknown Action "${step.action}"` });
      if (step.compensate && !actions.has(step.compensate.action)) {
        add({ code: "unknown-action", step: step.name, message: `step "${step.name}" compensates with unknown Action "${step.compensate.action}"` });
      }
      // A retry after an error may follow a call that did take effect (a timeout after the write); only an
      // Action the source recognizes as repeated may be called twice.
      if (action && action.idempotency === "none" && (step.retry?.maxAttempts ?? 1) > 1) {
        add({ code: "retry-not-idempotent", step: step.name, message: `step "${step.name}" retries "${action.name}", whose idempotency is none` });
      }
      // An Action that requires approval (ADR-0096) is refused at run time without a granted one, so the
      // checker says so first: an approval the step reads from, which cannot be skipped while the step runs.
      for (const effect of [action, step.compensate ? actions.get(step.compensate.action) : undefined]) {
        if (!effect?.requiresApproval) continue;
        const reads = upstream(workflow.steps, step.name);
        const approved = workflow.steps.some((s) => s.kind === "approval" && reads.has(s.name) && (!s.when || s.when === step.when));
        if (!approved) {
          add({
            code: "unapproved-action",
            step: step.name,
            message: `step "${step.name}" ${effect === action ? "invokes" : "compensates with"} "${effect.name}", which requires an approval, with no approval it needs that always runs before it`
          });
        }
      }
      // The step's own Action, and its compensation: both run on what the step read, the latter on any later failure.
      const compensation = step.compensate ? actions.get(step.compensate.action) : undefined;
      const unreviewed = new Set<string>();
      for (const effect of [action, compensation]) {
        if (!effect || effect.sideEffects === "none") continue;
        const reads = upstream(workflow.steps, step.name);
        for (const ai of workflow.steps.filter((s) => s.kind === "ai" && reads.has(s.name))) {
          // An approval reviews the answer only if it cannot be skipped while the AI step ran: it has no
          // condition, or the very condition the AI step has (the engine also refuses to skip it, ADR-0057).
          const reviewed = workflow.steps.some(
            (s) => s.kind === "approval" && reads.has(s.name) && upstream(workflow.steps, s.name).has(ai.name) && (!s.when || s.when === ai.when)
          );
          if (!reviewed && !unreviewed.has(ai.name)) {
            unreviewed.add(ai.name);
            add({
              code: "unreviewed-ai-output",
              step: step.name,
              message: `step "${step.name}" ${effect === action ? "invokes" : "compensates with"} "${effect.name}" (${effect.sideEffects}) from the output of AI step "${ai.name}" with no approval of it in between`
            });
          }
        }
      }
    }
    earlier.add(step.name);
  }
  return diagnostics;
}
