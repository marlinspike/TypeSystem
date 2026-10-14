import type { ActionDescription, JsonSchema2020, ModelDescription, TypeDescription } from "@typesys/core";
import { schemaToTs } from "@typesys/sdk";

/**
 * How a change lands on an existing consumer (ADR-0056):
 * - `breaking`: code written against the old model fails or misreads (a
 *   value or Action removed, a type changed, a new required input).
 * - `risky`: existing code keeps working but may now see something it did
 *   not handle (a new enum value in something it reads; a changed side
 *   effect).
 * - `compatible`: additions that no existing caller can notice.
 */
export type Impact = "breaking" | "risky" | "compatible";

export interface ContractChange {
  impact: Impact;
  /** `Type`, `Type.value`, `Type.relationship`, `Action`, or `Action.input.name`. */
  subject: string;
  change: string;
}

export interface VersionFinding {
  subject: string;
  from: string;
  to: string;
  /** The smallest semver bump the changes to this Type or Action need. */
  needs: "major" | "minor";
}

export interface ContractDiff {
  changes: ContractChange[];
  /** Types and Actions whose version did not move as far as their changes need (ADR-0010). */
  underVersioned: VersionFinding[];
}

function enumOf(schema: JsonSchema2020 | undefined): unknown[] | undefined {
  return schema?.enum ?? (schema?.const !== undefined ? [schema.const] : undefined);
}

/**
 * One value's schema, before and after. `direction` says who supplies it:
 * a consumer reads an `out` value, so new enum members are what it may
 * not handle; it supplies an `in` value, so removed members are what it
 * may still send.
 */
function compareSchema(subject: string, before: JsonSchema2020 | undefined, after: JsonSchema2020 | undefined, direction: "out" | "in", out: ContractChange[]): void {
  const [b, a] = [enumOf(before), enumOf(after)];
  if (b && a) {
    const added = a.filter((v) => !b.includes(v));
    const removed = b.filter((v) => !a.includes(v));
    const list = (vs: unknown[]) => vs.map((v) => JSON.stringify(v)).join(", ");
    if (removed.length > 0) out.push({ impact: "breaking", subject, change: `${direction === "in" ? "no longer accepts" : "can no longer be"} ${list(removed)}` });
    if (added.length > 0) out.push({ impact: direction === "out" ? "risky" : "compatible", subject, change: `now ${direction === "in" ? "accepts" : "may be"} ${list(added)}` });
    return;
  }
  const [bt, at] = [schemaToTs(before), schemaToTs(after)];
  if (bt !== at) {
    out.push({ impact: "breaking", subject, change: `type changed from ${bt.replace(/\s+/g, " ")} to ${at.replace(/\s+/g, " ")}` });
    return;
  }
  compareConstraints(subject, before, after, direction, out);
}

/** Keywords that bound a value without changing its TypeScript type: a larger `max*` or smaller `min*` admits more. */
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"] as const;
const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"] as const;
/** Keywords where any change is neither plainly wider nor narrower. */
const OTHER_CONSTRAINTS = ["format", "pattern", "multipleOf", "uniqueItems", "contentEncoding", "contentMediaType"] as const;

/**
 * The constraints `schemaToTs` cannot see (integer vs number, bounds,
 * format, pattern). What admits fewer values breaks a caller supplying an
 * `in` value; what admits more can surprise a consumer reading an `out`
 * value; a change that is neither is treated as both.
 */
function compareConstraints(subject: string, before: JsonSchema2020 | undefined, after: JsonSchema2020 | undefined, direction: "out" | "in", out: ContractChange[]): void {
  const changes: { narrower: boolean; wider: boolean; change: string }[] = [];
  const show = (v: unknown) => (v === undefined ? "none" : JSON.stringify(v));
  const [bType, aType] = [before?.type, after?.type];
  if (JSON.stringify(bType) !== JSON.stringify(aType)) {
    const narrower = bType === "number" && aType === "integer";
    const wider = bType === "integer" && aType === "number";
    changes.push({ narrower: narrower || !wider, wider: wider || !narrower, change: `type ${show(bType)} is now ${show(aType)}` });
  }
  for (const k of UPPER_BOUNDS) {
    const [b, a] = [before?.[k] as number | undefined, after?.[k] as number | undefined];
    if (b === a) continue;
    const narrower = a !== undefined && (b === undefined || a < b);
    changes.push({ narrower, wider: !narrower, change: `${k} ${show(b)} is now ${show(a)}` });
  }
  for (const k of LOWER_BOUNDS) {
    const [b, a] = [before?.[k] as number | undefined, after?.[k] as number | undefined];
    if (b === a) continue;
    const narrower = a !== undefined && (b === undefined || a > b);
    changes.push({ narrower, wider: !narrower, change: `${k} ${show(b)} is now ${show(a)}` });
  }
  for (const k of OTHER_CONSTRAINTS) {
    const [b, a] = [before?.[k], after?.[k]];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    changes.push({ narrower: a !== undefined && a !== false, wider: b !== undefined && b !== false, change: `${k} ${show(b)} is now ${show(a)}` });
  }
  for (const c of changes) {
    const impact: Impact = direction === "in" ? (c.narrower ? "breaking" : "compatible") : c.wider ? "risky" : "compatible";
    out.push({ impact, subject, change: c.change });
  }
}

function diffType(before: TypeDescription, after: TypeDescription, out: ContractChange[]): void {
  const t = after.name;
  const valuesOf = (type: TypeDescription) =>
    new Map<string, JsonSchema2020 | undefined>([...Object.entries(type.properties), ...type.computed.map((c) => [c.name, c.schema] as const)]);
  const [bv, av] = [valuesOf(before), valuesOf(after)];
  for (const [name, schema] of bv) {
    if (!av.has(name)) out.push({ impact: "breaking", subject: `${t}.${name}`, change: "value removed" });
    else {
      compareSchema(`${t}.${name}`, schema, av.get(name), "out", out);
      if (before.required.includes(name) && !after.required.includes(name)) out.push({ impact: "breaking", subject: `${t}.${name}`, change: "no longer required; readers may now see it missing" });
    }
  }
  for (const name of av.keys()) if (!bv.has(name)) out.push({ impact: "compatible", subject: `${t}.${name}`, change: "value added" });

  const relsAfter = new Map(after.relationships.map((r) => [r.name, r]));
  for (const rel of before.relationships) {
    const now = relsAfter.get(rel.name);
    const renamedTo = after.aliases?.[rel.name];
    if (!now) {
      out.push(
        renamedTo && relsAfter.has(renamedTo)
          ? { impact: "risky", subject: `${t}.${rel.name}`, change: `renamed to ${renamedTo}; the old name is accepted as an alias for now (ADR-0010)` }
          : { impact: "breaking", subject: `${t}.${rel.name}`, change: "relationship removed" }
      );
      continue;
    }
    if (now.target !== rel.target) out.push({ impact: "breaking", subject: `${t}.${rel.name}`, change: `target changed from ${rel.target} to ${now.target}` });
    if (now.cardinality !== rel.cardinality) {
      const many = (c: string) => c.endsWith("-to-many");
      out.push({
        impact: many(now.cardinality) === many(rel.cardinality) ? "compatible" : "breaking",
        subject: `${t}.${rel.name}`,
        change: `cardinality changed from ${rel.cardinality} to ${now.cardinality}`
      });
    }
  }
  // The runtime resolves a relationship's old name through its alias (ADR-0010); dropping the alias fails a query that still uses it.
  for (const [alias, current] of Object.entries(before.aliases ?? {})) {
    if (!before.relationships.some((r) => r.name === current) || relsAfter.has(alias) || after.aliases?.[alias] === current) continue;
    out.push({ impact: "breaking", subject: `${t}.${alias}`, change: after.aliases?.[alias] ? `alias now resolves to ${after.aliases[alias]}, was ${current}` : `alias for ${current} removed` });
  }
  for (const rel of after.relationships) {
    if (!before.relationships.some((r) => r.name === rel.name) && !Object.values(after.aliases ?? {}).includes(rel.name)) {
      out.push({ impact: "compatible", subject: `${t}.${rel.name}`, change: "relationship added" });
    }
  }
  if (after.deprecated && !before.deprecated) out.push({ impact: "risky", subject: t, change: `deprecated since ${after.deprecated.since}` });
}

function diffAction(before: ActionDescription, after: ActionDescription, out: ContractChange[]): void {
  const n = after.name;
  const bIn = before.inputSchema.properties ?? {};
  const aIn = after.inputSchema.properties ?? {};
  const bReq = new Set(before.inputSchema.required ?? []);
  const aReq = new Set(after.inputSchema.required ?? []);
  for (const [name, schema] of Object.entries(bIn)) {
    if (!(name in aIn)) {
      // A caller still sends it: refused outright when extra input is closed off, otherwise ignored.
      out.push({ impact: after.inputSchema.additionalProperties === false ? "breaking" : "risky", subject: `${n}.input.${name}`, change: "input removed" });
    } else {
      compareSchema(`${n}.input.${name}`, schema, aIn[name], "in", out);
      if (aReq.has(name) && !bReq.has(name)) out.push({ impact: "breaking", subject: `${n}.input.${name}`, change: "input now required" });
    }
  }
  if (after.inputSchema.additionalProperties === false && before.inputSchema.additionalProperties !== false)
    out.push({ impact: "breaking", subject: `${n}.input`, change: "inputs it does not name are now refused" });
  for (const name of Object.keys(aIn)) {
    if (!(name in bIn)) out.push({ impact: aReq.has(name) ? "breaking" : "compatible", subject: `${n}.input.${name}`, change: aReq.has(name) ? "required input added" : "optional input added" });
  }
  const bOut = before.outputSchema.properties ?? {};
  const aOut = after.outputSchema.properties ?? {};
  for (const [name, schema] of Object.entries(bOut)) {
    if (!(name in aOut)) out.push({ impact: "breaking", subject: `${n}.output.${name}`, change: "output removed" });
    else {
      compareSchema(`${n}.output.${name}`, schema, aOut[name], "out", out);
      if ((before.outputSchema.required ?? []).includes(name) && !(after.outputSchema.required ?? []).includes(name))
        out.push({ impact: "breaking", subject: `${n}.output.${name}`, change: "no longer required; callers may now see it missing" });
    }
  }
  for (const name of Object.keys(aOut)) if (!(name in bOut)) out.push({ impact: "compatible", subject: `${n}.output.${name}`, change: "output added" });

  const scope = (a: ActionDescription) => (a.target ? `one ${a.target.type} (id in ${a.target.idFrom})` : `per Type`);
  if (scope(before) !== scope(after)) out.push({ impact: "breaking", subject: n, change: `now decided ${scope(after)}, was ${scope(before)} (ADR-0053)` });
  if (before.sideEffects !== after.sideEffects) out.push({ impact: "risky", subject: n, change: `side effects changed from ${before.sideEffects} to ${after.sideEffects}` });
  if (before.idempotency !== after.idempotency) out.push({ impact: "risky", subject: n, change: `idempotency changed from ${before.idempotency} to ${after.idempotency}` });
  const removedTypes = before.applicableTypes.filter((t) => !after.applicableTypes.includes(t));
  if (removedTypes.length > 0) out.push({ impact: "breaking", subject: n, change: `no longer applies to ${removedTypes.join(", ")}` });
  if (after.deprecated && !before.deprecated) out.push({ impact: "risky", subject: n, change: `deprecated since ${after.deprecated.since}` });
}

const BUMP_RANK = { patch: 0, minor: 1, major: 2 } as const;

function bump(from: string, to: string): "major" | "minor" | "patch" | "none" {
  const [f, t] = [from, to].map((v) => v.split(/[.-]/).slice(0, 3).map(Number)) as [number[], number[]];
  if (t[0]! > f[0]!) return "major";
  // Before 1.0, a minor bump is the breaking one (semver item 4).
  if (t[0] === f[0] && t[1]! > f[1]!) return f[0] === 0 ? "major" : "minor";
  if (t[0] === f[0] && t[1] === f[1] && t[2]! > f[2]!) return "patch";
  return "none";
}

/**
 * What changed between two descriptions of a model, and how each change
 * lands on an existing consumer (ADR-0056). Also reports every Type or
 * Action whose version did not move as far as its changes need, which is
 * what a CI gate on a model change checks.
 */
export function diffModels(before: ModelDescription, after: ModelDescription): ContractDiff {
  const changes: ContractChange[] = [];
  const underVersioned: VersionFinding[] = [];

  const check = (subject: string, from: string, to: string, own: ContractChange[]) => {
    if (own.length === 0) return;
    // Any change to the contract is at least a feature for semver; a breaking one is a major.
    const needs = own.some((c) => c.impact === "breaking") ? "major" : "minor";
    const made = bump(from, to);
    if (made === "none" || BUMP_RANK[made] < BUMP_RANK[needs]) underVersioned.push({ subject, from, to, needs });
  };

  const typesAfter = new Map(after.types.map((t) => [t.name, t]));
  for (const t of before.types) {
    const now = typesAfter.get(t.name);
    if (!now) {
      changes.push({ impact: "breaking", subject: t.name, change: "Type removed" });
      continue;
    }
    const own: ContractChange[] = [];
    diffType(t, now, own);
    check(t.name, t.version, now.version, own);
    changes.push(...own);
  }
  for (const t of after.types) if (!before.types.some((b) => b.name === t.name)) changes.push({ impact: "compatible", subject: t.name, change: "Type added" });

  const actionsAfter = new Map(after.actions.map((a) => [a.name, a]));
  for (const a of before.actions) {
    const now = actionsAfter.get(a.name);
    if (!now) {
      changes.push({ impact: "breaking", subject: a.name, change: "Action removed" });
      continue;
    }
    const own: ContractChange[] = [];
    diffAction(a, now, own);
    check(a.name, a.version, now.version, own);
    changes.push(...own);
  }
  for (const a of after.actions) if (!before.actions.some((b) => b.name === a.name)) changes.push({ impact: "compatible", subject: a.name, change: "Action added" });

  return { changes, underVersioned };
}
