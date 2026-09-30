import type { Identity, PolicyEngine } from "../model/policy.js";
import { checkPlan, isExact, planAdmits } from "../policy/authorization-plan.js";

/** One way a planner broke the ADR-0038 contract. */
export interface PlanViolation {
  /**
   * `unsound`: the policy allows an object the plan excludes — authorized
   * data would be hidden. `overclaimed-exactness`: an exact plan admits an
   * object the policy denies. `planner-failed`: no usable plan at all.
   */
  violation: "unsound" | "overclaimed-exactness" | "planner-failed";
  subjectId: string;
  policyName: string;
  /** Index into `objects`, for the first two. */
  object?: number;
}

export interface PlanConformanceCases {
  typeName: string;
  policyNames: readonly string[];
  subjects: readonly Identity[];
  /** Stored attributes of candidate objects — the more edge cases (missing, wrong-typed, empty), the better. */
  objects: readonly Readonly<Record<string, unknown>>[];
}

/**
 * A differential check of a planner against its own engine (ADR-0038): for
 * every subject and policy, the engine's plan must admit every object its
 * `evaluate` allows, and an exact plan nothing more. Framework-agnostic, like
 * the registry-store contract: it returns the violations, and a test expects
 * none. An under-approximating plan can't be caught at runtime — the
 * post-read check never sees what the plan excluded — only here.
 */
export async function checkPlanConformance(engine: PolicyEngine, cases: PlanConformanceCases): Promise<PlanViolation[]> {
  if (typeof engine.plan !== "function") throw new TypeError("checkPlanConformance needs an engine with plan()");
  const violations: PlanViolation[] = [];
  for (const subject of cases.subjects) {
    for (const policyName of cases.policyNames) {
      const plan = checkPlan(await engine.plan({ subject, action: "read", policyName, resource: { typeName: cases.typeName } }).catch(() => undefined));
      if (!plan) {
        violations.push({ violation: "planner-failed", subjectId: subject.subjectId, policyName });
        continue;
      }
      for (const [index, attributes] of cases.objects.entries()) {
        // As the runtime decides: only an explicit allow allows, and a throw denies.
        const decision = await engine.evaluate({ subject, action: "read", policyName, resource: { typeName: cases.typeName, objectId: `o${index}`, attributes } }).catch(() => undefined);
        const allowed = decision?.allow === true;
        const admitted = planAdmits(plan, attributes);
        if (allowed && !admitted) violations.push({ violation: "unsound", subjectId: subject.subjectId, policyName, object: index });
        else if (!allowed && admitted && isExact(plan)) violations.push({ violation: "overclaimed-exactness", subjectId: subject.subjectId, policyName, object: index });
      }
    }
  }
  return violations;
}
