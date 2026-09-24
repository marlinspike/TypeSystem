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
