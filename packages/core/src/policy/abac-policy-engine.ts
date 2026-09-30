import type { PolicyEngine, PolicyRequest, PolicyDecision } from "../model/policy.js";
import { ALWAYS, NEVER, allPlans, anyPlan, isPlanIdentifier, predicatePlan, unknownPlan, type AuthorizationPlan } from "./authorization-plan.js";

export type PolicyRule = (request: PolicyRequest) => PolicyDecision | Promise<PolicyDecision>;

/**
 * A rule that can also say what it admits (ADR-0038) — every combinator
 * below is one, planning from the same structure it evaluates, so the plan
 * can't drift from the decision. `plan` gets a type-level request and MUST
 * admit every object `evaluate` would allow for that subject.
 */
export interface PlannableRule {
  (request: PolicyRequest): PolicyDecision | Promise<PolicyDecision>;
  plan(request: PolicyRequest): AuthorizationPlan | Promise<AuthorizationPlan>;
}

function plannable(rule: PolicyRule, plan: PlannableRule["plan"]): PlannableRule {
  return Object.assign(rule, { plan });
}

/** A rule's plan: its own, or — for a plain function rule — `unknown`, which admits everything. */
async function planOf(rule: PolicyRule, request: PolicyRequest): Promise<AuthorizationPlan> {
  const plan = (rule as Partial<PlannableRule>).plan;
  return typeof plan === "function" ? plan.call(rule, request) : unknownPlan([{ code: "opaque-rule", policyName: request.policyName }]);
}

/**
 * A small embedded ABAC evaluator (see ADR-0009). Deliberately swappable —
 * the runtime only ever calls the `PolicyEngine` interface, so a real
 * policy-as-code engine (OPA, Cedar) could replace this without touching
 * runtime call sites. Unknown policy names deny by default (fail closed).
 */
export class AbacPolicyEngine implements PolicyEngine {
  private readonly rules = new Map<string, PolicyRule>();

  registerRule(policyName: string, rule: PolicyRule): void {
    this.rules.set(policyName, rule);
  }

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    const rule = this.rules.get(request.policyName);
    if (!rule) {
      return { allow: false, reason: `No policy rule registered for "${request.policyName}" (fail closed)` };
    }
    return rule(request);
  }

  /** From the registered rule's own structure (ADR-0038). An unregistered policy denies everything, so it plans `never`. */
  async plan(request: PolicyRequest): Promise<AuthorizationPlan> {
    const rule = this.rules.get(request.policyName);
    return rule ? planOf(rule, request) : NEVER;
  }
}

/** Always allows — useful for a "public" policy name on genuinely open resources. */
export const allowAllRule: PolicyRule = plannable(
  () => ({ allow: true }),
  () => ALWAYS
);

/** Allows only when the subject has one of the given roles. */
export function requireRole(...roles: string[]): PolicyRule {
  const holds = (request: PolicyRequest) => request.subject.roles.some((r) => roles.includes(r));
  return plannable(
    (request) =>
      holds(request)
        ? { allow: true }
        : { allow: false, reason: `Requires one of roles [${roles.join(", ")}], subject has [${request.subject.roles.join(", ")}]` },
    (request) => (holds(request) ? ALWAYS : NEVER)
  );
}

/** An own property usable as an identifier: a non-empty string or a finite number. Anything else never matches. */
function identifierAt(bag: Readonly<Record<string, unknown>> | undefined, name: string): string | number | undefined {
  if (!bag || !Object.hasOwn(bag, name)) return undefined;
  const value = bag[name];
  return isPlanIdentifier(value) ? value : undefined;
}

/**
 * Row-level (ADR-0030): allows only when the resource's `resourceAttribute`
 * and the subject's `subjectAttribute` are the same identifier — e.g.
 * `requireAttributeMatch("assignedClinicianId", "providerId")`. A value
 * missing on both sides is never a match, and a type-level request (no
 * `resource.attributes`) is denied, since it asks about every instance.
 * The deny reason names the attributes, never their values.
 */
export function requireAttributeMatch(resourceAttribute: string, subjectAttribute: string): PolicyRule {
  return plannable(
    ({ resource, subject }) => {
      const owned = identifierAt(resource.attributes, resourceAttribute);
      const allow = owned !== undefined && owned === identifierAt(subject.attributes, subjectAttribute);
      return allow
        ? { allow: true }
        : { allow: false, reason: `Requires resource.${resourceAttribute} to match subject.${subjectAttribute}` };
    },
    // The objects whose attribute is the subject's own value; none, when the subject has no usable value.
    ({ subject }) => {
      const wanted = identifierAt(subject.attributes, subjectAttribute);
      return wanted === undefined ? NEVER : predicatePlan({ attribute: resourceAttribute, eq: wanted });
    }
  );
}

function requireSomeRules(combinator: string, rules: PolicyRule[]): void {
  if (rules.length === 0) throw new TypeError(`${combinator}() needs at least one rule`);
}

/** Allows when any rule allows, tried in order. Denies with every rule's reason otherwise. */
export function anyOf(...rules: PolicyRule[]): PolicyRule {
  requireSomeRules("anyOf", rules);
  return plannable(
    async (request) => {
      const reasons: string[] = [];
      for (const rule of rules) {
        const decision = await rule(request);
        if (decision.allow === true) return decision;
        if (decision.reason) reasons.push(decision.reason);
      }
      return { allow: false, reason: `No alternative allowed: ${reasons.join("; ")}` };
    },
    async (request) => anyPlan(await Promise.all(rules.map((rule) => planOf(rule, request))))
  );
}

/** Allows only when every rule allows, tried in order. Denies with the first denying rule's reason. */
export function allOf(...rules: PolicyRule[]): PolicyRule {
  requireSomeRules("allOf", rules);
  return plannable(
    async (request) => {
      for (const rule of rules) {
        const decision = await rule(request);
        if (decision.allow !== true) return { ...decision, allow: false };
      }
      return { allow: true };
    },
    async (request) => allPlans(await Promise.all(rules.map((rule) => planOf(rule, request))))
  );
}
