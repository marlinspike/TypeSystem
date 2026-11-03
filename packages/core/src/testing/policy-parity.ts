import { describeRule, type PolicyRule } from "../policy/abac-policy-engine.js";
import type { PolicyRequest } from "../model/policy.js";

/** One way two rules differ on one request: the decision, its reason, or the plan. */
export interface PolicyParityDifference {
  readonly policy: string;
  readonly request: number;
  readonly what: "decision" | "reason" | "plan" | "description" | "missing";
  readonly before: unknown;
  readonly after: unknown;
}

const planOf = async (rule: PolicyRule, request: PolicyRequest): Promise<unknown> => {
  const plan = (rule as { plan?: (r: PolicyRequest) => unknown }).plan;
  return typeof plan === "function" ? JSON.parse(JSON.stringify(await plan.call(rule, request))) : "opaque";
};

const decide = async (rule: PolicyRule, request: PolicyRequest): Promise<{ allow: boolean; reason?: string } | "throws"> => {
  try {
    const d = await rule(request);
    return { allow: d.allow === true, ...(d.reason !== undefined ? { reason: d.reason } : {}) };
  } catch {
    return "throws";
  }
};

/**
 * Every difference between two sets of named rules over the given requests
 * (ADR-0100): each rule's decision and deny reason on every request, its
 * plan on every request's type-level form, and its description. Used to
 * prove that rules rewritten as data decide exactly as the code they
 * replace. `ignore` skips a comparison for named policies, such as a
 * description that changes on purpose.
 */
export async function comparePolicyRules(
  before: Readonly<Record<string, PolicyRule>>,
  after: Readonly<Record<string, PolicyRule>>,
  requests: readonly Omit<PolicyRequest, "policyName">[],
  ignore: Readonly<Record<string, readonly PolicyParityDifference["what"][]>> = {}
): Promise<PolicyParityDifference[]> {
  const out: PolicyParityDifference[] = [];
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const policy of names) {
    const a = before[policy];
    const b = after[policy];
    const skip = new Set(ignore[policy] ?? []);
    if (!a || !b) {
      out.push({ policy, request: -1, what: "missing", before: Boolean(a), after: Boolean(b) });
      continue;
    }
    if (!skip.has("description") && describeRule(a) !== describeRule(b)) out.push({ policy, request: -1, what: "description", before: describeRule(a), after: describeRule(b) });
    for (const [i, r] of requests.entries()) {
      const request: PolicyRequest = { ...r, policyName: policy };
      const [da, db] = await Promise.all([decide(a, request), decide(b, request)]);
      const allowA = da === "throws" ? "throws" : da.allow;
      const allowB = db === "throws" ? "throws" : db.allow;
      if (allowA !== allowB) out.push({ policy, request: i, what: "decision", before: allowA, after: allowB });
      else if (!skip.has("reason") && da !== "throws" && db !== "throws" && da.reason !== db.reason) out.push({ policy, request: i, what: "reason", before: da.reason, after: db.reason });
      const typeLevel: PolicyRequest = { ...request, resource: { typeName: request.resource.typeName } };
      if (!skip.has("plan")) {
        const [pa, pb] = await Promise.all([planOf(a, typeLevel), planOf(b, typeLevel)]);
        if (JSON.stringify(pa) !== JSON.stringify(pb)) out.push({ policy, request: i, what: "plan", before: pa, after: pb });
      }
    }
  }
  return out;
}
