import { randomUUID } from "node:crypto";
import type { Identity } from "../model/policy.js";
import type { PolicyLiteral, PolicyRule } from "./abac-policy-engine.js";
import { compilePolicy, type PolicyExpression } from "./policy-document.js";

/**
 * Exact comparison of two policy expressions (ADR-0109): every request the
 * new one admits that the old one refused, found by construction rather
 * than by sampling personas.
 *
 * Why it is exact. A policy expression (ADR-0100) has no negation: it is an
 * `anyOf`/`allOf` tree over atoms that each test one thing about the request
 * (the subject holds a role; a resource attribute equals the subject's; a
 * resource attribute is a literal; the request is type level). Written in
 * disjunctive normal form, the new expression admits a request exactly when
 * one of its conjunctions holds. For each conjunction, the smallest request
 * that satisfies it (only the roles it names, only the attributes it needs,
 * fresh values that equal nothing they need not) makes true exactly the atoms
 * the conjunction forces, and any other request satisfying it makes true at
 * least those. The old expression is monotone in its atoms, so if it refuses
 * the smallest request, that request is a witness; if it admits it, it
 * admits every request the conjunction covers. Both are then decided by the
 * compiled rules themselves, so the comparison uses the runtime's own semantics.
 */

/** A request the new expression admits and the old one refused. */
export interface PolicyWitness {
  readonly roles: readonly string[];
  /** Subject attributes the request needs; anything else is absent. */
  readonly subjectAttributes: Readonly<Record<string, string | number>>;
  /** `type-level`: a request about every instance (a list, a filter); otherwise one object with these stored attributes. */
  readonly resource: "type-level" | { readonly attributes: Readonly<Record<string, PolicyLiteral>> };
  /** The conjunction of the new expression that admits it, as text. */
  readonly because: string;
  /** The same subject is also admitted to requests about every instance (lists and filters). */
  readonly andTypeLevel?: boolean;
}

export interface PolicyComparison {
  /** Every distinct widening; empty when the new expression admits nothing the old refused. */
  readonly widens: readonly PolicyWitness[];
  /** Every distinct narrowing: requests the old admitted and the new refuses. */
  readonly narrows: readonly PolicyWitness[];
}

/** Too many conjunctions to enumerate: compare by sampling instead. */
/** Two policies could not be compared exactly. A caller treats the change as possibly widening. */
export class PolicyNotComparableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyNotComparableError";
  }
}

export class PolicyTooLargeError extends PolicyNotComparableError {
  constructor(readonly conjunctions: number) {
    super(`The policy has more than ${conjunctions} alternatives in normal form; it is too large to compare exactly`);
    this.name = "PolicyTooLargeError";
  }
}

/** Sets an own property, even one named `__proto__`, which plain assignment would treat as the prototype. */
function put<T>(bag: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(bag, key, { value, enumerable: true, writable: true, configurable: true });
}

type Atom =
  | { readonly kind: "always" }
  | { readonly kind: "role"; readonly role: string }
  | { readonly kind: "match"; readonly resource: string; readonly subject: string }
  | { readonly kind: "value"; readonly attribute: string; readonly equals: PolicyLiteral; readonly typeLevel: "allow" | "deny" };

const LIMIT = 4096;
const FRESH = `fresh-${randomUUID()}-`;
const isFresh = (v: PolicyLiteral): boolean => typeof v === "string" && v.startsWith(FRESH);

function dnf(expr: PolicyExpression): Atom[][] {
  if (expr === "always") return [[{ kind: "always" }]];
  if ("role" in expr) return expr.role.map((role) => [{ kind: "role", role }]);
  if ("attributeMatch" in expr) return [[{ kind: "match", resource: expr.attributeMatch.resource, subject: expr.attributeMatch.subject }]];
  if ("resourceValue" in expr) return [[{ kind: "value", attribute: expr.resourceValue.attribute, equals: expr.resourceValue.equals, typeLevel: expr.resourceValue.typeLevel ?? "deny" }]];
  if ("anyOf" in expr) {
    const out = expr.anyOf.flatMap(dnf);
    if (out.length > LIMIT) throw new PolicyTooLargeError(LIMIT);
    return out;
  }
  let acc: Atom[][] = [[]];
  for (const child of expr.allOf) {
    const next: Atom[][] = [];
    for (const left of acc) for (const right of dnf(child)) next.push([...left, ...right]);
    if (next.length > LIMIT) throw new PolicyTooLargeError(LIMIT);
    acc = next;
  }
  return acc;
}

const isIdentifier = (v: PolicyLiteral): v is string | number => (typeof v === "string" && v !== "") || (typeof v === "number" && Number.isFinite(v));

interface Request {
  readonly roles: string[];
  readonly subjectAttributes: Record<string, string | number>;
  readonly resource: "type-level" | { attributes: Record<string, PolicyLiteral> };
}

/** The smallest instance-level request satisfying `atoms`, or none when they contradict each other. */
function instanceRequest(atoms: readonly Atom[], fresh: () => string): Request | undefined {
  // Union-find over the attributes the atoms equate: `r:<name>` for a resource attribute, `s:<name>` for a subject one.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  const nodes = new Set<string>();
  for (const a of atoms)
    if (a.kind === "match") {
      nodes.add(`r:${a.resource}`);
      nodes.add(`s:${a.subject}`);
      union(`r:${a.resource}`, `s:${a.subject}`);
    } else if (a.kind === "value") nodes.add(`r:${a.attribute}`);
  const constant = new Map<string, PolicyLiteral>();
  const matched = new Set<string>();
  for (const a of atoms) if (a.kind === "match") matched.add(find(`r:${a.resource}`));
  for (const a of atoms) {
    if (a.kind !== "value") continue;
    const root = find(`r:${a.attribute}`);
    if (constant.has(root) && constant.get(root) !== a.equals) return undefined;
    // An attribute match holds only between identifiers: a boolean or null cannot also be matched.
    if (matched.has(root) && !isIdentifier(a.equals)) return undefined;
    constant.set(root, a.equals);
  }
  const valueOf = new Map<string, PolicyLiteral>();
  for (const n of nodes) {
    const root = find(n);
    if (!valueOf.has(root)) valueOf.set(root, constant.has(root) ? constant.get(root)! : fresh());
  }
  const resource: Record<string, PolicyLiteral> = {};
  const subjectAttributes: Record<string, string | number> = {};
  for (const n of [...nodes].sort()) {
    const v = valueOf.get(find(n))!;
    if (n.startsWith("r:")) put(resource, n.slice(2), v);
    else put(subjectAttributes, n.slice(2), v as string | number);
  }
  return { roles: rolesOf(atoms), subjectAttributes, resource: { attributes: resource } };
}

function rolesOf(atoms: readonly Atom[]): string[] {
  return [...new Set(atoms.flatMap((a) => (a.kind === "role" ? [a.role] : [])))].sort();
}

/** The type-level request satisfying `atoms`, when one can: no attribute match, and every value test allows type level. */
function typeLevelRequest(atoms: readonly Atom[]): Request | undefined {
  if (atoms.some((a) => a.kind === "match" || (a.kind === "value" && a.typeLevel !== "allow"))) return undefined;
  return { roles: rolesOf(atoms), subjectAttributes: {}, resource: "type-level" };
}

function describe(atoms: readonly Atom[]): string {
  if (atoms.length === 0) return "always";
  return atoms
    .map((a) =>
      a.kind === "always"
        ? "always"
        : a.kind === "role"
          ? `role ${a.role}`
          : a.kind === "match"
            ? `resource.${a.resource} = subject.${a.subject}`
            : `resource.${a.attribute} = ${JSON.stringify(a.equals)}${a.typeLevel === "allow" ? " (or type level)" : ""}`
    )
    .join(" and ");
}

async function decide(rule: PolicyRule, r: Request): Promise<boolean> {
  const subject: Identity = { subjectId: "policy-diff", roles: r.roles, attributes: r.subjectAttributes };
  try {
    const d = await rule({
      subject,
      action: "read",
      policyName: "policy-diff",
      resource: r.resource === "type-level" ? { typeName: "policy-diff.Any" } : { typeName: "policy-diff.Any", objectId: "x", attributes: Object.freeze({ ...r.resource.attributes }) }
    });
    return d.allow === true;
  } catch {
    // A rule that throws denies (the runtime fails closed, ADR-0043).
    return false;
  }
}

async function oneWay(from: PolicyExpression | undefined, to: PolicyExpression): Promise<PolicyWitness[]> {
  const ruleTo = compilePolicy(to);
  const ruleFrom = from === undefined ? undefined : compilePolicy(from);
  let n = 0;
  // Fresh values equal nothing either expression names: a literal can never collide with one by accident.
  const fresh = () => `${FRESH}${++n}`;
  const seen = new Set<string>();
  const out: PolicyWitness[] = [];
  for (const conj of dnf(to)) {
    const atoms = conj.filter((a) => a.kind !== "always");
    const found: Request[] = [];
    for (const req of [instanceRequest(atoms, fresh), typeLevelRequest(atoms)]) {
      if (!req) continue;
      // The constructed request must satisfy the conjunction under the runtime's own rule. If it does not, the
      // construction is wrong, and saying "no widening" would be a guess: refuse to compare instead.
      if (!(await decide(ruleTo, req))) throw new PolicyNotComparableError(`A request built to satisfy "${describe(atoms)}" was refused by the rule itself; the change cannot be compared exactly`);
      if (ruleFrom && (await decide(ruleFrom, req))) continue;
      found.push(req);
    }
    // A conjunction on no attribute that widens both an object read and a list is one finding: "on any object, and in lists".
    const both = found.length === 2 && found[0]!.resource !== "type-level" && Object.keys(found[0]!.resource.attributes).length === 0;
    for (const req of both ? [found[0]!] : found) {
      const w: PolicyWitness = { roles: req.roles, subjectAttributes: req.subjectAttributes, resource: req.resource, because: describe(atoms), ...(both ? { andTypeLevel: true } : {}) };
      const key = JSON.stringify([w.roles, Object.keys(w.subjectAttributes).sort(), w.resource === "type-level" ? "t" : Object.entries(w.resource.attributes).map(([k, v]) => [k, isFresh(v) ? "*" : v]), both]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}

/**
 * Every request `after` admits that `before` refused, and the reverse. A
 * policy absent `before` (a new rule) refuses everything, as an unknown
 * policy name does at run time. Throws `PolicyTooLargeError` for an
 * expression with more than 4,096 alternatives in normal form.
 */
export async function comparePolicies(before: PolicyExpression | undefined, after: PolicyExpression | undefined): Promise<PolicyComparison> {
  return {
    widens: after === undefined ? [] : await oneWay(before, after),
    narrows: before === undefined ? [] : await oneWay(after, before)
  };
}

/** A witness as one line a reviewer reads. */
export function describeWitness(w: PolicyWitness): string {
  const who = w.roles.length ? `a subject with role${w.roles.length > 1 ? "s" : ""} ${w.roles.join(", ")}` : "a subject with no role";
  const attrs = Object.keys(w.subjectAttributes);
  const subject = attrs.length ? `${who} and ${attrs.map((a) => `a ${a}`).join(", ")}` : who;
  if (w.resource === "type-level") return `${subject}, asking about every instance (a list or filter)`;
  const ra = Object.entries(w.resource.attributes);
  if (ra.length === 0) return `${subject}, on any object${w.andTypeLevel ? " and in lists" : ""}`;
  const condition = ([k, v]: (typeof ra)[number]): string => {
    if (!isFresh(v)) return `${k} = ${JSON.stringify(v)}`;
    const same = attrs.find((a) => w.subjectAttributes[a] === v);
    return same === undefined ? `${k} matches the subject's` : `${k} equals the subject's ${same}`;
  };
  return `${subject}, on an object whose ${ra.map(condition).join(" and ")}`;
}
