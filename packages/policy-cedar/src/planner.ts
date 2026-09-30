import type { ResidualResponse } from "@cedar-policy/cedar-wasm/nodejs";
import { ALWAYS, NEVER, allPlans, anyPlan, isPlanIdentifier, predicatePlan, unknownPlan, type AuthorizationPlan, type PlanIdentifier } from "@typesys/core";

/**
 * From Cedar's residuals to an ADR-0038 plan (ADR-0039). Partial evaluation
 * is experimental upstream, so the translator trusts only the expression
 * shapes it recognizes: every other subterm — always in a position under
 * only `&&` and `||` — is replaced by `true`, which only ever admits more.
 */
export interface ResidualContext {
  /** The TypeS policy name: what limitations name. */
  policyName: string;
  /** The queried Type, as a Cedar entity type: what `resource is T` is decided against. */
  cedarType: string;
  /** The queried Type's name, for the `unverified-attribute-types` limitation. */
  typeName: string;
  /** Whether the schema declares any attributes on the resource's entity type. */
  declaresAttributes: boolean;
  /** The deployment's assertion that stored values always have the schema's types. */
  schemaConformantData: boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
/** The single operator key of an expression node, e.g. `"&&"`, or `undefined` for anything else. */
function opOf(expr: unknown): string | undefined {
  if (!isObject(expr)) return undefined;
  const keys = Object.keys(expr);
  return keys.length === 1 ? keys[0] : undefined;
}

/** `unknown("resource")`. */
function isUnknownResource(expr: unknown): boolean {
  if (opOf(expr) !== "unknown") return false;
  const args = (expr as Json).unknown;
  return Array.isArray(args) && args.length === 1 && isObject(args[0]) && args[0].Value === "resource";
}

/** The attribute `resource.a` reads, if `expr` is exactly that. */
function resourceAttribute(expr: unknown): string | undefined {
  if (opOf(expr) !== ".") return undefined;
  const node = (expr as Json)["."];
  if (!isObject(node) || !isUnknownResource(node.left) || typeof node.attr !== "string") return undefined;
  return node.attr;
}

/** `resource.a == v`, either way round, with `v` an identifier literal. */
function equality(expr: unknown): { attribute: string; eq: PlanIdentifier } | undefined {
  if (opOf(expr) !== "==") return undefined;
  const node = (expr as Json)["=="];
  if (!isObject(node)) return undefined;
  for (const [attr, lit] of [[node.left, node.right], [node.right, node.left]] as const) {
    const attribute = resourceAttribute(attr);
    const value = opOf(lit) === "Value" ? (lit as Json).Value : undefined;
    if (attribute !== undefined && isPlanIdentifier(value)) return { attribute, eq: value };
  }
  return undefined;
}

type Primitive = string | number | boolean;
const isPrimitive = (v: unknown): v is Primitive => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/** `resource.a == v` with `v` any primitive literal — including ones an atom can't hold, like `""`. */
function literalEquality(expr: unknown): { attribute: string; value: Primitive } | undefined {
  if (opOf(expr) !== "==") return undefined;
  const node = (expr as Json)["=="];
  if (!isObject(node)) return undefined;
  for (const [attr, lit] of [[node.left, node.right], [node.right, node.left]] as const) {
    const attribute = resourceAttribute(attr);
    const value = opOf(lit) === "Value" ? (lit as Json).Value : undefined;
    if (attribute !== undefined && isPrimitive(value)) return { attribute, value };
  }
  return undefined;
}

/** `has resource.a`. */
function hasAttribute(expr: unknown): string | undefined {
  if (opOf(expr) !== "has") return undefined;
  const node = (expr as Json).has;
  return isObject(node) && isUnknownResource(node.left) && typeof node.attr === "string" ? node.attr : undefined;
}

/** The operand of `!expr`. */
function negated(expr: unknown): unknown {
  if (opOf(expr) !== "!") return undefined;
  const node = (expr as Json)["!"];
  return isObject(node) ? node.arg : undefined;
}

/** A conjunction's operands, `&&` chains flattened. */
function conjuncts(expr: unknown): unknown[] {
  if (opOf(expr) !== "&&") return [expr];
  const node = (expr as Json)["&&"];
  return isObject(node) ? [...conjuncts(node.left), ...conjuncts(node.right)] : [expr];
}

/**
 * What translation saw along the way. A weakened subterm is also one Cedar
 * might fail to evaluate, and any error denies the whole request, so once
 * anything is weakened no plan built around it may claim to be exact — even
 * where `always OR …` absorbed it (ADR-0039).
 */
interface Translation extends ResidualContext {
  weakened: boolean;
}

function weakenedPlan(ctx: Translation): AuthorizationPlan {
  ctx.weakened = true;
  return unknownPlan([{ code: "unrepresentable-condition", policyName: ctx.policyName }]);
}

/** One residual expression as a plan, on its own. */
export function translateResidual(expr: unknown, ctx: ResidualContext): AuthorizationPlan {
  return translate(expr, { ...ctx, weakened: false });
}

function translate(expr: unknown, ctx: Translation): AuthorizationPlan {
  const op = opOf(expr);
  if (op === "&&") return translateConjunction(conjuncts(expr), ctx);
  if (op === "||") {
    const node = (expr as Json)["||"];
    return isObject(node) ? anyPlan([translate(node.left, ctx), translate(node.right, ctx)]) : weakenedPlan(ctx);
  }
  if (op === "Value") {
    const value = (expr as Json).Value;
    return value === true ? ALWAYS : value === false ? NEVER : weakenedPlan(ctx);
  }
  if (op === "is") {
    const node = (expr as Json).is;
    if (isObject(node) && isUnknownResource(node.left) && typeof node.entity_type === "string" && !("in" in node)) {
      return node.entity_type === ctx.cedarType ? ALWAYS : NEVER;
    }
    return weakenedPlan(ctx);
  }
  const atom = equality(expr);
  return atom ? predicatePlan(atom) : weakenedPlan(ctx);
}

/**
 * A conjunction, simplified by what its equalities pin: given
 * `resource.a == c`, `has resource.a` and `!(resource.a == d)` for `d ≠ c`
 * are implied, `!(resource.a == c)` is a contradiction, and so is a second
 * `resource.a == d`. Exact: each follows from `==` alone — Cedar's `==` is
 * strict, so values of different types are simply unequal.
 */
function translateConjunction(parts: unknown[], ctx: Translation): AuthorizationPlan {
  const pinned = new Map<string, Primitive>();
  for (const part of parts) {
    const pin = literalEquality(part);
    if (!pin) continue;
    if (pinned.has(pin.attribute) && pinned.get(pin.attribute) !== pin.value) return NEVER;
    pinned.set(pin.attribute, pin.value);
  }
  return allPlans(
    parts.map((part) => {
      const has = hasAttribute(part);
      if (has !== undefined && pinned.has(has)) return ALWAYS;
      const excluded = literalEquality(negated(part));
      if (excluded && pinned.has(excluded.attribute)) return pinned.get(excluded.attribute) === excluded.value ? NEVER : ALWAYS;
      return translate(part, ctx);
    })
  );
}

/** One residual policy's conditions: every `when` holds and no `unless` does. */
function translatePolicy(policy: unknown, ctx: Translation): AuthorizationPlan {
  if (!isObject(policy) || !Array.isArray(policy.conditions)) return weakenedPlan(ctx);
  // Partial evaluation folds the scope into the conditions; a scope still constrained is a shape this version doesn't expect.
  for (const scope of [policy.principal, policy.action, policy.resource]) if (!isObject(scope) || scope.op !== "All") return weakenedPlan(ctx);
  return allPlans(
    policy.conditions.map((clause: unknown) => {
      if (!isObject(clause)) return weakenedPlan(ctx);
      const body = translate(clause.body, ctx);
      if (clause.kind === "when") return body;
      if (clause.kind === "unless") return body.kind === "always" ? NEVER : body.kind === "never" ? ALWAYS : weakenedPlan(ctx);
      return weakenedPlan(ctx);
    })
  );
}

/**
 * The plan a partial-evaluation response amounts to. An errored policy errs
 * for every resource, and any error denies, so it plans `never`. Permits
 * combine with `anyPlan`; a forbid that holds for every resource makes it
 * `never`, one that holds for none drops out, and any other is left to the
 * post-read check. A Type with declared attributes is exact only on the
 * deployment's assertion that its data conforms to the schema.
 */
export function planFromResiduals(response: ResidualResponse, context: ResidualContext): AuthorizationPlan {
  if (response.errored.length > 0) return NEVER;
  const ctx: Translation = { ...context, weakened: false };
  let plan: AuthorizationPlan;
  if (response.decision === "allow") plan = ALWAYS;
  else if (response.decision === "deny") plan = NEVER;
  else {
    const policies = Object.values(response.residuals);
    const permits = anyPlan(policies.filter((p) => p.effect === "permit").map((p) => translatePolicy(p, ctx)));
    const forbids = policies.filter((p) => p.effect !== "permit").map((p) => translatePolicy(p, ctx));
    if (forbids.some((f) => f.kind === "always")) return NEVER;
    const excluding = forbids.some((f) => f.kind !== "never");
    plan = allPlans([
      permits,
      ...(excluding ? [unknownPlan([{ code: "negated-condition", policyName: ctx.policyName }])] : []),
      // A weakened subterm might error, and an error anywhere denies: nothing absorbed it exactly.
      ...(ctx.weakened ? [unknownPlan([{ code: "unrepresentable-condition", policyName: ctx.policyName }])] : [])
    ]);
  }
  if (plan.kind === "never" || !ctx.declaresAttributes || ctx.schemaConformantData) return plan;
  return allPlans([plan, unknownPlan([{ code: "unverified-attribute-types", typeName: ctx.typeName }])]);
}
