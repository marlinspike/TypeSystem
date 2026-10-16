import type { AnyStep, AnyWorkflow } from "@typesys/workflow";
import { canonical } from "@typesys/core";
import { refsOf } from "./expr.js";
import type { FlowIR, StepIR } from "./ir.js";

/**
 * The engine step a flow step becomes, and the steps it reads. A parallel
 * step is one engine step; its reads are referred to by their own names in
 * the IR, and by the parallel step's name in the engine.
 */
export interface LoweredStep {
  readonly ir: StepIR;
  /** The engine step's name: the step's own, or for a read inside `parallel`, the parallel step's. */
  readonly engineName: string;
  /** Earlier engine steps whose outputs it reads, in first-use order. */
  readonly needs: readonly string[];
}

/** IR step names → the engine step that produces each one's output. */
export function engineNames(flow: FlowIR): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of flow.steps) {
    out.set(s.name, s.name);
    if (s.kind === "parallel") for (const r of s.steps) out.set(r.name, s.name);
  }
  return out;
}

/** What each step of a flow reads: references to earlier steps (by engine name), and an approval's presented steps. */
export function lowerSteps(flow: FlowIR): LoweredStep[] {
  const names = engineNames(flow);
  const seen = new Set<string>();
  const out: LoweredStep[] = [];
  for (const s of flow.steps) {
    const refs = s.kind === "approval" ? [...s.present, ...refsOf(s.when)] : s.kind === "parallel" ? s.steps.flatMap((r) => refsOf(r)) : refsOf({ ...s, name: undefined, kind: undefined });
    const needs: string[] = [];
    // A flow runs in order, so an Action runs after every approval before it: the engine is told so, and its
    // AI-review rule (ADR-0057) sees the approval between a proposal and the Action that uses it.
    if (s.kind === "action") for (const p of out) if (p.ir.kind === "approval") needs.push(p.engineName);
    for (const r of refs) {
      const engine = names.get(r);
      if (engine && seen.has(engine) && engine !== s.name && !needs.includes(engine)) needs.push(engine);
    }
    out.push({ ir: s, engineName: s.name, needs });
    seen.add(s.name);
  }
  return out;
}

/**
 * The flow as the engine would hold it, with placeholders for every function
 * (ADR-0081): what `validateWorkflow`, the engine's own check, is run on
 * before any code is generated. Steps with the same condition get the same
 * condition function, as the generated code gives them, because the engine's
 * AI-review rule compares conditions by identity.
 */
export function skeleton(flow: FlowIR): AnyWorkflow {
  const conditions = new Map<string, (ctx: unknown) => boolean>();
  const when = (e: unknown) => {
    if (e === undefined) return {};
    const key = canonical(e);
    let fn = conditions.get(key);
    if (!fn) conditions.set(key, (fn = () => true));
    return { when: fn };
  };
  const steps: AnyStep[] = lowerSteps(flow).map(({ ir: s, needs }) => {
    const base = { name: s.name, ...(needs.length ? { needs } : {}), ...when(s.when), ...(s.retry ? { retry: s.retry } : {}) };
    switch (s.kind) {
      case "read":
      case "parallel":
      case "forEach":
        return { ...base, kind: "read", run: async () => undefined };
      case "compute":
      case "check":
        return { ...base, kind: "compute", run: () => undefined };
      case "ai":
        return { ...base, kind: "ai", prompt: s.prompt, input: () => undefined, outputSchema: s.output, ...(s.release ? { release: s.release } : {}) };
      case "approval":
        return { ...base, kind: "approval", policy: s.policy, ...(s.allowSelfApproval ? { allowSelfApproval: true } : {}), ...(s.deadlineMs ? { deadline: { afterMs: s.deadlineMs } } : {}) };
      case "action":
        return {
          ...base,
          kind: "action",
          action: s.action,
          input: () => ({}),
          ...(s.compensate ? { compensate: { action: s.compensate.action, input: () => ({}) } } : {})
        };
    }
  });
  return {
    name: flow.name,
    version: flow.version,
    startPolicy: flow.startPolicy,
    ...(flow.cancelPolicy ? { cancelPolicy: flow.cancelPolicy } : {}),
    inputSchema: inputSchema(flow),
    steps
  };
}

/** A flow's input as JSON Schema: every field required, nothing else admitted. */
export function inputSchema(flow: FlowIR): Record<string, unknown> & { type: "object" } {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(flow.input).map(([k, v]) => [k, v.schema])),
    required: Object.keys(flow.input),
    additionalProperties: false
  };
}
