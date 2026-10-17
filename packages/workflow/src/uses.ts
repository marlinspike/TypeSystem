import type { GraphConsumer, GraphUse } from "@typesys/devkit";
import type { ModelShape } from "@typesys/sdk";
import type { AnyWorkflow, WorkflowDefinition } from "./definition.js";

/**
 * What a workflow uses, for the dependency graph (ADR-0090): its start and
 * cancel policies, and per step the Types it declares it reads, the Actions
 * it invokes and compensates with, the approval policy, and the steps it
 * needs. A read step that declares no `reads` runs an opaque function and
 * is marked so, rather than guessed at.
 */
export function workflowUses<M extends ModelShape, I>(definition: WorkflowDefinition<M, I>): GraphConsumer {
  const workflow = definition as unknown as AnyWorkflow;
  return {
    kind: "workflow",
    name: workflow.name,
    version: workflow.version,
    uses: [
      { kind: "policy", policy: workflow.startPolicy, how: "start" },
      ...(workflow.cancelPolicy ? [{ kind: "policy", policy: workflow.cancelPolicy, how: "cancel" } as const] : [])
    ],
    parts: workflow.steps.map((step) => {
      const uses: GraphUse[] = (step.needs ?? []).map((part) => ({ kind: "part", part, how: "needs" }));
      let opaque: string | undefined;
      switch (step.kind) {
        case "read":
          if (step.reads) for (const type of step.reads) uses.push({ kind: "type", type, whole: true, how: "read" });
          else opaque = "a read step without `reads` may read any Type";
          break;
        case "approval":
          uses.push({ kind: "policy", policy: step.policy, how: "approval" });
          break;
        case "action":
          uses.push({ kind: "action", action: step.action, how: "invoke" });
          if (step.compensate) uses.push({ kind: "action", action: step.compensate.action, how: "compensate" });
          break;
        case "ai":
        case "compute":
          break;
      }
      return { name: step.name, kind: step.kind, ...(step.description ? { label: step.description } : {}), uses, ...(opaque ? { opaque } : {}) };
    })
  };
}
