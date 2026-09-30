import type { PolicyEngine, PolicyRequest, PolicyDecision } from "../model/policy.js";

export type PolicyRule = (request: PolicyRequest) => PolicyDecision | Promise<PolicyDecision>;

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
}

/** Always allows — useful for a "public" policy name on genuinely open resources. */
export const allowAllRule: PolicyRule = () => ({ allow: true });

/** Allows only when the subject has one of the given roles. */
export function requireRole(...roles: string[]): PolicyRule {
  return (request) => {
    const allow = request.subject.roles.some((r) => roles.includes(r));
    return allow
      ? { allow: true }
      : { allow: false, reason: `Requires one of roles [${roles.join(", ")}], subject has [${request.subject.roles.join(", ")}]` };
  };
}

/** An own property usable as an identifier: a non-empty string or a finite number. Anything else never matches. */
function identifierAt(bag: Readonly<Record<string, unknown>> | undefined, name: string): string | number | undefined {
  if (!bag || !Object.hasOwn(bag, name)) return undefined;
  const value = bag[name];
  return (typeof value === "string" && value !== "") || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
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
  return ({ resource, subject }) => {
    const owned = identifierAt(resource.attributes, resourceAttribute);
    const allow = owned !== undefined && owned === identifierAt(subject.attributes, subjectAttribute);
    return allow
      ? { allow: true }
      : { allow: false, reason: `Requires resource.${resourceAttribute} to match subject.${subjectAttribute}` };
  };
}

function requireSomeRules(combinator: string, rules: PolicyRule[]): void {
  if (rules.length === 0) throw new TypeError(`${combinator}() needs at least one rule`);
}

/** Allows when any rule allows, tried in order. Denies with every rule's reason otherwise. */
export function anyOf(...rules: PolicyRule[]): PolicyRule {
  requireSomeRules("anyOf", rules);
  return async (request) => {
    const reasons: string[] = [];
    for (const rule of rules) {
      const decision = await rule(request);
      if (decision.allow === true) return decision;
      if (decision.reason) reasons.push(decision.reason);
    }
    return { allow: false, reason: `No alternative allowed: ${reasons.join("; ")}` };
  };
}

/** Allows only when every rule allows, tried in order. Denies with the first denying rule's reason. */
export function allOf(...rules: PolicyRule[]): PolicyRule {
  requireSomeRules("allOf", rules);
  return async (request) => {
    for (const rule of rules) {
      const decision = await rule(request);
      if (decision.allow !== true) return { ...decision, allow: false };
    }
    return { allow: true };
  };
}
