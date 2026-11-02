import { allOf, allowAllRule, anyOf, requireAttributeMatch, requireResourceValue, requireRole, type PolicyLiteral, type PolicyRule } from "./abac-policy-engine.js";

/**
 * A policy rule written as data (ADR-0100): the combinators of
 * `abac-policy-engine.ts`, one JSON value each, so a deployment manifest can
 * hold its rules, a reviewer can read them, and two versions can be diffed.
 * Compiled by `compilePolicy` into exactly the rule the combinator builds,
 * with the same decisions, plans and descriptions.
 *
 * - `"always"`: `allowAllRule`.
 * - `{ "role": ["maintainer", "viewer"] }`: `requireRole`.
 * - `{ "attributeMatch": { "resource": "assignedTo", "subject": "displayName" } }`: `requireAttributeMatch`.
 * - `{ "resourceValue": { "attribute": "embargoed", "equals": false, "typeLevel": "allow" } }`: `requireResourceValue`.
 * - `{ "anyOf": [...] }` and `{ "allOf": [...] }`: `anyOf` and `allOf`.
 */
export type PolicyExpression =
  | "always"
  | { readonly role: readonly string[] }
  | { readonly attributeMatch: { readonly resource: string; readonly subject: string } }
  | {
      readonly resourceValue: {
        readonly attribute: string;
        readonly equals: PolicyLiteral;
        readonly typeLevel?: "allow" | "deny";
        /** The deny reason, for a rule whose refusal should say why in the domain's words. Never quote a value. */
        readonly reason?: string;
      };
    }
  | { readonly anyOf: readonly PolicyExpression[] }
  | { readonly allOf: readonly PolicyExpression[] };

/** Named rules as data: what a deployment manifest's `policies` holds. */
export type PolicyDocument = Readonly<Record<string, PolicyExpression>>;

/** A policy expression that is not one of the forms above, with every problem found and where. */
export class PolicyDocumentError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid policy: ${problems.join("; ")}`);
    this.name = "PolicyDocumentError";
  }
}

const KEYS = ["role", "attributeMatch", "resourceValue", "anyOf", "allOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], at: string, out: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) out.push(`${at}: unknown field "${key}"`);
}

/** Every problem with `expr`, each prefixed with where it is (`at`). Empty means it compiles. */
export function validatePolicyExpression(expr: unknown, at = "policy"): string[] {
  const out: string[] = [];
  check(expr, at, out, 0);
  return out;
}

/** Deep enough for any real rule, shallow enough that a hostile document cannot exhaust the stack. */
const MAX_DEPTH = 32;

function check(expr: unknown, at: string, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) {
    out.push(`${at}: nested more than ${MAX_DEPTH} levels deep`);
    return;
  }
  if (expr === "always") return;
  if (!isRecord(expr)) {
    out.push(`${at}: must be "always" or an object with one of ${KEYS.join(", ")}`);
    return;
  }
  const present = KEYS.filter((k) => Object.hasOwn(expr, k));
  if (present.length !== 1) {
    out.push(`${at}: must have exactly one of ${KEYS.join(", ")}${present.length ? `, has ${present.join(", ")}` : ""}`);
    return;
  }
  onlyKeys(expr, present, at, out);
  const key = present[0]!;
  const body = expr[key];
  switch (key) {
    case "role":
      if (!Array.isArray(body) || body.length === 0 || !body.every(nonEmptyString)) out.push(`${at}.role: must be a non-empty list of role names`);
      return;
    case "attributeMatch":
      if (!isRecord(body)) {
        out.push(`${at}.attributeMatch: must be { resource, subject }`);
        return;
      }
      onlyKeys(body, ["resource", "subject"], `${at}.attributeMatch`, out);
      if (!nonEmptyString(body.resource)) out.push(`${at}.attributeMatch.resource: must be an attribute name`);
      if (!nonEmptyString(body.subject)) out.push(`${at}.attributeMatch.subject: must be an attribute name`);
      return;
    case "resourceValue": {
      if (!isRecord(body)) {
        out.push(`${at}.resourceValue: must be { attribute, equals, typeLevel?, reason? }`);
        return;
      }
      onlyKeys(body, ["attribute", "equals", "typeLevel", "reason"], `${at}.resourceValue`, out);
      if (!nonEmptyString(body.attribute)) out.push(`${at}.resourceValue.attribute: must be an attribute name`);
      const equals = body.equals;
      const literal =
        equals === null || typeof equals === "boolean" || (typeof equals === "string" && equals !== "") || (typeof equals === "number" && Number.isFinite(equals));
      if (!Object.hasOwn(body, "equals") || !literal) out.push(`${at}.resourceValue.equals: must be a non-empty string, a finite number, a boolean or null`);
      if (body.typeLevel !== undefined && body.typeLevel !== "allow" && body.typeLevel !== "deny") out.push(`${at}.resourceValue.typeLevel: must be "allow" or "deny"`);
      if (body.reason !== undefined && !nonEmptyString(body.reason)) out.push(`${at}.resourceValue.reason: must be a non-empty string`);
      return;
    }
    case "anyOf":
    case "allOf":
      if (!Array.isArray(body) || body.length === 0) {
        out.push(`${at}.${key}: must be a non-empty list of policies`);
        return;
      }
      body.forEach((child, i) => check(child, `${at}.${key}[${i}]`, out, depth + 1));
      return;
  }
}

/**
 * The rule `expr` describes, built by the combinators themselves, so its
 * decisions, plan and description are theirs. Throws `PolicyDocumentError`
 * naming every problem when `expr` is not a policy expression.
 */
export function compilePolicy(expr: PolicyExpression, at = "policy"): PolicyRule {
  const problems = validatePolicyExpression(expr, at);
  if (problems.length > 0) throw new PolicyDocumentError(problems);
  return build(expr);
}

function build(expr: PolicyExpression): PolicyRule {
  if (expr === "always") return allowAllRule;
  if ("role" in expr) return requireRole(...expr.role);
  if ("attributeMatch" in expr) return requireAttributeMatch(expr.attributeMatch.resource, expr.attributeMatch.subject);
  if ("resourceValue" in expr) {
    const { attribute, equals, typeLevel, reason } = expr.resourceValue;
    return requireResourceValue(attribute, equals, { ...(typeLevel ? { typeLevel } : {}), ...(reason ? { reason } : {}) });
  }
  if ("anyOf" in expr) return anyOf(...expr.anyOf.map(build));
  return allOf(...expr.allOf.map(build));
}

/** Every rule of a document, compiled; every problem in every rule is reported at once. */
export function compilePolicies(document: PolicyDocument): Record<string, PolicyRule> {
  if (!isRecord(document)) throw new PolicyDocumentError(["policies: must be an object of named rules"]);
  const problems = Object.entries(document).flatMap(([name, expr]) => [
    ...(nonEmptyString(name) ? [] : ["policies: a rule name must be non-empty"]),
    ...validatePolicyExpression(expr, `policies["${name}"]`)
  ]);
  if (problems.length > 0) throw new PolicyDocumentError(problems);
  return Object.fromEntries(Object.entries(document).map(([name, expr]) => [name, build(expr)]));
}
