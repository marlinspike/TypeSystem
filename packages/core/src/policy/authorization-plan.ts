import type { QueryFilter } from "../model/query.js";

/**
 * Authorization plans (ADR-0038): what a read policy admits, as something a
 * store can apply before it reads. A plan MUST be a sound over-approximation
 * — it admits everything the policy would allow — and it is `exact` when it
 * admits nothing more. The post-read check stays either way.
 */

/** An identifier a policy compares: a non-empty string or a finite number, compared strictly. */
export type PlanIdentifier = string | number;

/**
 * Deliberately positive — no negation — so replacing any part with `true`
 * only ever admits more. An `eq` atom holds exactly when the object's stored
 * attribute is that identifier (`===`), as `requireAttributeMatch` tests it.
 */
export type AuthorizationPredicate =
  | { readonly attribute: string; readonly eq: PlanIdentifier }
  | { readonly and: readonly AuthorizationPredicate[] }
  | { readonly or: readonly AuthorizationPredicate[] };

/** Why a plan isn't exact — always a value, never text. */
export type AuthorizationPlanLimitation =
  | { readonly code: "engine-cannot-plan" }
  | { readonly code: "opaque-rule"; readonly policyName: string }
  | { readonly code: "planner-failed"; readonly policyName: string }
  | { readonly code: "protected-attribute"; readonly attribute: string }
  | { readonly code: "cross-source-attribute"; readonly attribute: string }
  /** Part of the policy's condition has no predicate form, so it was replaced by `true` (ADR-0039). */
  | { readonly code: "unrepresentable-condition"; readonly policyName: string }
  /** A condition that excludes objects — a Cedar `forbid` — which a positive predicate can't say (ADR-0039). */
  | { readonly code: "negated-condition"; readonly policyName: string }
  /** The engine refuses objects whose declared attributes are mistyped, which no store filter can exclude (ADR-0039). */
  | { readonly code: "unverified-attribute-types"; readonly typeName: string };

export type AuthorizationPlan =
  | { readonly kind: "always" }
  | { readonly kind: "never" }
  | {
      readonly kind: "predicate";
      readonly predicate: AuthorizationPredicate;
      readonly exact: boolean;
      readonly limitations: readonly AuthorizationPlanLimitation[];
    }
  | { readonly kind: "unknown"; readonly limitations: readonly AuthorizationPlanLimitation[] };

/** Every object: exact. */
export const ALWAYS: AuthorizationPlan = Object.freeze({ kind: "always" });
/** No object: exact. */
export const NEVER: AuthorizationPlan = Object.freeze({ kind: "never" });

function distinct(limitations: readonly AuthorizationPlanLimitation[]): AuthorizationPlanLimitation[] {
  const seen = new Map(limitations.map((l) => [JSON.stringify(l), l]));
  return [...seen.values()];
}

/** A predicate plan, exact exactly when it has no limitations. */
export function predicatePlan(predicate: AuthorizationPredicate, limitations: readonly AuthorizationPlanLimitation[] = []): AuthorizationPlan {
  const listed = distinct(limitations);
  return Object.freeze({ kind: "predicate", predicate, exact: listed.length === 0, limitations: Object.freeze(listed) });
}

/** Admits every object, and says why no better plan exists. */
export function unknownPlan(limitations: readonly AuthorizationPlanLimitation[]): AuthorizationPlan {
  const listed = distinct(limitations);
  if (listed.length === 0) throw new TypeError("an unknown plan must say why");
  return Object.freeze({ kind: "unknown", limitations: Object.freeze(listed) });
}

/** Whether a plan admits exactly what the policy allows. */
export function isExact(plan: AuthorizationPlan): boolean {
  return plan.kind === "always" || plan.kind === "never" || (plan.kind === "predicate" && plan.exact);
}

export function limitationsOf(plan: AuthorizationPlan): readonly AuthorizationPlanLimitation[] {
  return plan.kind === "predicate" || plan.kind === "unknown" ? plan.limitations : [];
}

/**
 * The conjunction. `never` anywhere is `never`, exactly, whatever else is
 * unknown; `always` drops out; an `unknown` weakens to `true`, so the rest
 * still narrows the result but it is no longer exact.
 */
export function allPlans(plans: readonly AuthorizationPlan[]): AuthorizationPlan {
  if (plans.some((p) => p.kind === "never")) return NEVER;
  const predicates = plans.flatMap((p) => (p.kind === "predicate" ? [p.predicate] : []));
  const limitations = plans.flatMap(limitationsOf);
  if (predicates.length === 0) return limitations.length === 0 ? ALWAYS : unknownPlan(limitations);
  return predicatePlan(predicates.length === 1 ? predicates[0]! : { and: flatten("and", predicates) }, limitations);
}

/**
 * The disjunction. `always` anywhere is `always`, exactly, whatever else is
 * unknown; `never` drops out; an `unknown` admits everything, so it swallows
 * the rest.
 */
export function anyPlan(plans: readonly AuthorizationPlan[]): AuthorizationPlan {
  if (plans.some((p) => p.kind === "always")) return ALWAYS;
  const unknown = plans.filter((p) => p.kind === "unknown");
  if (unknown.length > 0) return unknownPlan(plans.flatMap(limitationsOf));
  const predicates = plans.flatMap((p) => (p.kind === "predicate" ? [p.predicate] : []));
  if (predicates.length === 0) return NEVER;
  return predicatePlan(predicates.length === 1 ? predicates[0]! : { or: flatten("or", predicates) }, plans.flatMap(limitationsOf));
}

function flatten(op: "and" | "or", predicates: readonly AuthorizationPredicate[]): AuthorizationPredicate[] {
  return predicates.flatMap((p) => (op in p ? (p as Record<typeof op, readonly AuthorizationPredicate[]>)[op] : [p]));
}

/** Whether `value` is an identifier a plan can compare. */
export function isPlanIdentifier(value: unknown): value is PlanIdentifier {
  return (typeof value === "string" && value !== "") || (typeof value === "number" && Number.isFinite(value));
}

/** Whether the object with these stored attributes satisfies the predicate. */
export function predicateAdmits(predicate: AuthorizationPredicate, attributes: Readonly<Record<string, unknown>>): boolean {
  if ("and" in predicate) return predicate.and.every((p) => predicateAdmits(p, attributes));
  if ("or" in predicate) return predicate.or.some((p) => predicateAdmits(p, attributes));
  return Object.hasOwn(attributes, predicate.attribute) && attributes[predicate.attribute] === predicate.eq;
}

/** Whether the plan admits the object with these stored attributes. */
export function planAdmits(plan: AuthorizationPlan, attributes: Readonly<Record<string, unknown>>): boolean {
  if (plan.kind === "never") return false;
  if (plan.kind === "predicate") return predicateAdmits(plan.predicate, attributes);
  return true;
}

/** The predicate in the query filter DSL, whose `eq` is the same strict comparison. */
export function predicateToFilter(predicate: AuthorizationPredicate): QueryFilter {
  if ("and" in predicate) return { and: predicate.and.map(predicateToFilter) };
  if ("or" in predicate) return { or: predicate.or.map(predicateToFilter) };
  return { property: predicate.attribute, operator: "eq", value: predicate.eq };
}

/**
 * Rebuilds `predicate` atom by atom through `fit`, which returns the plan an
 * atom becomes where the data is: itself, `NEVER`, or `unknownPlan(…)` —
 * `true`, with the reason. Recombined through `allPlans` / `anyPlan`, so
 * every replacement simplifies and exactness is recovered where it can be.
 */
export function refitPredicate(predicate: AuthorizationPredicate, fit: (atom: { attribute: string; eq: PlanIdentifier }) => AuthorizationPlan): AuthorizationPlan {
  if ("and" in predicate) return allPlans(predicate.and.map((p) => refitPredicate(p, fit)));
  if ("or" in predicate) return anyPlan(predicate.or.map((p) => refitPredicate(p, fit)));
  return fit(predicate);
}

/** The field each limitation code names, if any. */
const LIMITATION_FIELDS: Readonly<Record<AuthorizationPlanLimitation["code"], string | undefined>> = {
  "engine-cannot-plan": undefined,
  "opaque-rule": "policyName",
  "planner-failed": "policyName",
  "protected-attribute": "attribute",
  "cross-source-attribute": "attribute",
  "unrepresentable-condition": "policyName",
  "negated-condition": "policyName",
  "unverified-attribute-types": "typeName"
};

function isPredicate(value: unknown, depth = 0): value is AuthorizationPredicate {
  if (depth > 64 || typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const keys = Object.keys(p).sort().join(",");
  if (keys === "and" || keys === "or") {
    const children = p[keys];
    return Array.isArray(children) && children.length > 0 && children.every((c) => isPredicate(c, depth + 1));
  }
  return keys === "attribute,eq" && typeof p.attribute === "string" && p.attribute !== "" && isPlanIdentifier(p.eq);
}

function isLimitation(value: unknown): value is AuthorizationPlanLimitation {
  if (typeof value !== "object" || value === null) return false;
  const l = value as Record<string, unknown>;
  if (typeof l.code !== "string" || !Object.hasOwn(LIMITATION_FIELDS, l.code)) return false;
  const field = LIMITATION_FIELDS[l.code as AuthorizationPlanLimitation["code"]];
  return field === undefined || (typeof l[field] === "string" && l[field] !== "");
}

/**
 * A plan an engine returned, rebuilt through the constructors — or
 * `undefined` if it is malformed, or claims an exactness its limitations
 * contradict. What the runtime does with `undefined` is a planner defect.
 */
export function checkPlan(value: unknown): AuthorizationPlan | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const plan = value as Record<string, unknown>;
  if (plan.kind === "always") return ALWAYS;
  if (plan.kind === "never") return NEVER;
  const limitations = plan.limitations;
  if (!(Array.isArray(limitations) && limitations.every(isLimitation))) return undefined;
  if (plan.kind === "unknown") return limitations.length > 0 ? unknownPlan(limitations) : undefined;
  if (plan.kind !== "predicate" || !isPredicate(plan.predicate) || typeof plan.exact !== "boolean") return undefined;
  if (plan.exact !== (limitations.length === 0)) return undefined;
  return predicatePlan(plan.predicate, limitations);
}
