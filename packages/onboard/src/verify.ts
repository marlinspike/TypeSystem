import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  AuthorizationError,
  buildRuntime,
  DEMO_LINEAR_CLASSIFICATION,
  InMemoryRegistryStore,
  requireRole,
  SemanticRegistry,
  type Adapter,
  type ClassificationScheme,
  type Identity,
  type JsonSchema2020,
  type PolicyRule,
  type SemanticRuntime
} from "@typesys/core";
import { buildPack, checkUpgrade, installPacks, manifestOf, PackError, type PackArchive, type UpgradeReport } from "@typesys/packs";
import { buildDomain, type BuiltDomain } from "./build.js";
import { DOMAIN, fingerprint, MEMBER, TYPE_LOCAL, type Proposal } from "./proposal.js";
import type { SourceModel } from "./sources.js";

export interface VerifyDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: "ungrounded" | "stale-evidence" | "invalid-name" | "duplicate-name" | "pack" | "install" | "upgrade" | "unserved";
  /** The proposal item it is about, when there is one. */
  readonly item?: string;
  readonly message: string;
}

/**
 * A check generated from the proposal, run against the live sources through
 * the runtime (ADR-0076): it shows the mapping reads what the evidence says
 * is there, not that the model's reading is right.
 */
export type OnboardingCheck =
  | { readonly id: string; readonly kind: "reads"; readonly type: string }
  | { readonly id: string; readonly kind: "conforms"; readonly type: string; readonly schema: JsonSchema2020 }
  | { readonly id: string; readonly kind: "gets"; readonly type: string }
  | { readonly id: string; readonly kind: "follows"; readonly type: string; readonly relationship: string; readonly target: string; readonly field: string; readonly via: "own-field" | "foreign-key" }
  | { readonly id: string; readonly kind: "protects"; readonly type: string; readonly property: string; readonly policy: string }
  | { readonly id: string; readonly kind: "marks"; readonly type: string; readonly property: string; readonly marking: string };

export interface Verification {
  /** No error: the proposal builds, installs and is grounded in its evidence. */
  readonly ok: boolean;
  readonly diagnostics: readonly VerifyDiagnostic[];
  readonly built: BuiltDomain;
  readonly pack?: PackArchive;
  readonly upgrade?: UpgradeReport;
  readonly checks: readonly OnboardingCheck[];
}

export interface VerifyOptions {
  readonly version?: string;
  readonly description?: string;
  /** The pack this one would replace: its upgrade is checked for breaking changes against the version bump. */
  readonly previous?: PackArchive;
}

/**
 * Everything TypeSystem can decide about a proposal without trusting the
 * model that refined it (ADR-0076): each item cites evidence that exists and
 * says what it said when the item was made; names are valid and unique;
 * the domain builds as a pack, and the pack installs into an empty
 * registry, so every schema compiles and every reference resolves; an
 * upgrade bumps the version its contract changes need. Then it generates
 * the checks that run against the live sources.
 */
export async function verifyProposal(model: SourceModel, p: Proposal, options: VerifyOptions = {}): Promise<Verification> {
  const diagnostics: VerifyDiagnostic[] = [];
  const err = (code: VerifyDiagnostic["code"], message: string, item?: string) => diagnostics.push({ severity: "error", code, message, ...(item ? { item } : {}) });
  const warn = (code: VerifyDiagnostic["code"], message: string, item?: string) => diagnostics.push({ severity: "warning", code, message, ...(item ? { item } : {}) });

  if (!DOMAIN.test(p.domain)) err("invalid-name", `Domain "${p.domain}" is not lower case letters, digits and "-"`);
  const items = [...p.types, ...p.types.flatMap((t) => t.properties), ...p.relationships, ...p.sensitive, ...p.actions, ...p.findings];
  for (const it of items) {
    const missing = it.cites.filter((c) => !model.evidence.has(c));
    if (missing.length) err("ungrounded", `${it.id} cites evidence that does not exist: ${missing.join(", ")}`, it.id);
    else if (fingerprint(model, it.cites) !== it.fingerprint) warn("stale-evidence", `${it.id}: what it cites has changed since it was proposed`, it.id);
  }
  const typeNames = new Set<string>();
  for (const t of p.types) {
    if (!model.entity(t.entity)) err("ungrounded", `${t.name} is from ${t.entity}, which is not in the evidence`, t.id);
    const [domain, local] = t.name.split(".");
    if (domain !== p.domain || !local || !TYPE_LOCAL.test(local)) err("invalid-name", `"${t.name}" is not ${p.domain}.<PascalCase>`, t.id);
    if (typeNames.has(t.name)) err("duplicate-name", `Two Types are named ${t.name}`, t.id);
    typeNames.add(t.name);
    const members = new Set<string>();
    for (const x of t.properties) {
      if (!model.field(x.field) || model.field(x.field)!.entity.id !== t.entity) err("ungrounded", `${t.name}.${x.name} is from ${x.field}, which is not a field of ${t.entity}`, x.id);
      if (!MEMBER.test(x.name)) err("invalid-name", `"${x.name}" on ${t.name} is not camelCase`, x.id);
      if (members.has(x.name)) err("duplicate-name", `${t.name} has two members named ${x.name}`, x.id);
      members.add(x.name);
    }
    if (!t.properties.some((x) => x.name === t.key)) err("ungrounded", `${t.name}'s key ${t.key} is not one of its properties`, t.id);
  }
  const actionNames = new Set<string>();
  for (const a of p.actions) {
    if (!TYPE_LOCAL.test(a.name)) err("invalid-name", `Action "${a.name}" is not PascalCase`, a.id);
    if (actionNames.has(a.name)) err("duplicate-name", `Two Actions are named ${a.name}`, a.id);
    actionNames.add(a.name);
  }

  // A Type, relationship or Action whose evidence is gone cannot be built: say so, and build nothing.
  const grounded = !diagnostics.some((d) => d.code === "ungrounded");
  const built = buildDomain(model, grounded ? p : { ...p, types: [], relationships: [], sensitive: [], actions: [] }, options.version);
  for (const n of built.notes) warn("unserved", n);
  const memberClash = built.manifest.types.flatMap((t) => Object.keys(t.schema["x-relationships"] ?? {}).filter((r) => Object.hasOwn(t.schema.properties ?? {}, r)).map((r) => `${t.options.name}.${r}`));
  for (const m of memberClash) err("duplicate-name", `${m} is both a property and a relationship`);

  let pack: PackArchive | undefined;
  let upgrade: UpgradeReport | undefined;
  if (!diagnostics.some((d) => d.severity === "error")) {
    try {
      pack = buildPack({ name: p.domain, version: options.version ?? "1.0.0", description: options.description ?? `${p.domain}, onboarded from ${p.sources.map((s) => s.system).join(", ")}`, manifests: [built.manifest] });
    } catch (e) {
      if (e instanceof PackError) for (const d of e.diagnostics) err("pack", d.message, d.subject);
      else err("pack", (e as Error).message);
    }
  }
  if (pack) {
    // Installed for real into an empty registry: every schema compiles and every reference resolves, or it says which does not.
    try {
      await installPacks(new SemanticRegistry(new InMemoryRegistryStore()), [pack], { bindings: { computed: {}, preconditions: {} }, policies: built.policies });
    } catch (e) {
      if (e instanceof PackError) for (const d of e.diagnostics) err("install", d.message, d.subject);
      else err("install", (e as Error).message);
    }
    if (options.previous) {
      upgrade = await checkUpgrade([options.previous], pack);
      for (const d of upgrade.diagnostics) err("upgrade", d.message, d.subject);
    }
  }
  return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics, built, ...(pack ? { pack } : {}), ...(upgrade ? { upgrade } : {}), checks: generateChecks(built) };
}

/** The checks a domain's mapping must pass against its live sources. */
export function generateChecks(built: BuiltDomain): OnboardingCheck[] {
  const checks: OnboardingCheck[] = [];
  for (const t of built.manifest.types) {
    const name = t.options.name;
    checks.push({ id: `reads:${name}`, kind: "reads", type: name });
    checks.push({ id: `conforms:${name}`, kind: "conforms", type: name, schema: { type: "object", properties: t.schema.properties ?? {}, required: t.schema.required ?? [] } });
    checks.push({ id: `gets:${name}`, kind: "gets", type: name });
    for (const [rel, spec] of Object.entries(t.schema["x-relationships"] ?? {})) {
      const [how, field] = spec.resolution.operation.split(":");
      checks.push({ id: `follows:${name}.${rel}`, kind: "follows", type: name, relationship: rel, target: spec.target, field: field!, via: how === "byOwnField" ? "own-field" : "foreign-key" });
    }
    for (const [prop, policy] of Object.entries(t.schema["x-policy"]?.propertyPolicies ?? {})) checks.push({ id: `protects:${name}.${prop}`, kind: "protects", type: name, property: prop, policy });
    for (const [prop, spec] of Object.entries(t.schema["x-provenance"]?.properties ?? {})) if (spec.classification) checks.push({ id: `marks:${name}.${prop}`, kind: "marks", type: name, property: prop, marking: spec.classification });
  }
  return checks;
}

export interface CheckResult {
  readonly id: string;
  /** `inconclusive`: the sources hold nothing the check could be decided on (no record with the value, say). */
  readonly outcome: "passed" | "failed" | "inconclusive";
  readonly detail: string;
}

/**
 * A runtime over an onboarded pack for running its checks: every rule the
 * pack names is a role of the same name, so the checks can read as a
 * caller who holds a rule and as one who does not. It is for verification,
 * never a deployment's policy.
 */
export async function checkRuntime(pack: PackArchive, adapters: readonly Adapter[], classification: ClassificationScheme = DEMO_LINEAR_CLASSIFICATION): Promise<{ runtime: SemanticRuntime; everything: Identity; without: (rule: string) => Identity; clearedTo: (level: string) => Identity }> {
  const rules: Record<string, PolicyRule> = Object.fromEntries(pack.requirements.policies.map((r) => [r, requireRole(r)]));
  const { runtime } = await buildRuntime({ manifests: [manifestOf(pack, { computed: {}, preconditions: {} })], adapters: [...adapters], policyRules: rules, runtimeOptions: { classification } });
  const levels = "levels" in classification ? (classification as { levels: readonly string[] }).levels : [];
  const everything: Identity = { subjectId: "onboarding-check", roles: [...pack.requirements.policies], attributes: {}, ...(levels.length ? { clearance: levels.at(-1)! } : {}) };
  return {
    runtime,
    everything,
    without: (rule) => ({ ...everything, subjectId: `onboarding-check-without-${rule}`, roles: everything.roles.filter((r) => r !== rule) }),
    clearedTo: (level) => ({ ...everything, subjectId: `onboarding-check-${level}`, clearance: level })
  };
}

/** Runs each check through the runtime; a check that cannot run says why. */
export async function runChecks(env: Awaited<ReturnType<typeof checkRuntime>>, checks: readonly OnboardingCheck[]): Promise<CheckResult[]> {
  const { runtime, everything } = env;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  const sample = new Map<string, { objectId: string; values: Record<string, unknown> }[]>();
  const items = async (type: string) => {
    if (!sample.has(type)) sample.set(type, (await runtime.query({ type, limit: 25 }, everything)).items.map((o) => ({ objectId: o.objectId, values: o.values })));
    return sample.get(type)!;
  };
  const out: CheckResult[] = [];
  for (const c of checks) {
    try {
      const r = await runOne(c);
      out.push({ id: c.id, outcome: r.passed === undefined ? "inconclusive" : r.passed ? "passed" : "failed", detail: r.detail });
    } catch (e) {
      out.push({ id: c.id, outcome: "failed", detail: `${(e as Error).name}: ${(e as Error).message}` });
    }
  }
  return out;

  async function runOne(c: OnboardingCheck): Promise<{ passed: boolean | undefined; detail: string }> {
    switch (c.kind) {
      case "reads": {
        const n = (await items(c.type)).length;
        return { passed: n > 0, detail: `${n} read` };
      }
      case "conforms": {
        const validate = ajv.compile(c.schema);
        const bad = (await items(c.type)).filter((o) => !validate(o.values));
        return { passed: bad.length === 0, detail: bad.length ? `${bad[0]!.objectId}: ${ajv.errorsText(validate.errors)}` : "every value conforms" };
      }
      case "gets": {
        const [first] = await items(c.type);
        if (!first) return { passed: undefined, detail: `no ${c.type} to get` };
        const one = await runtime.getObject(c.type, first.objectId, everything);
        const same = JSON.stringify(sorted(one.values)) === JSON.stringify(sorted(first.values));
        return { passed: same, detail: same ? `${first.objectId} read alone as in a query` : `${first.objectId} differs read alone` };
      }
      case "follows": {
        for (const o of await items(c.type)) {
          const related = await runtime.getRelationship(c.type, o.objectId, c.relationship, everything);
          if (related.length === 0) continue;
          // Own field: the related object's id is this object's field. Foreign key: each related object's field is this object's id.
          const ok = related.every((r) => (c.via === "own-field" ? r.objectId === String(o.values[c.field]) : String(r.values[c.field]) === o.objectId));
          return { passed: ok, detail: `${o.objectId} → ${related.length} ${c.target}${ok ? "" : ", not all matching"}` };
        }
        return { passed: undefined, detail: `no ${c.type} read has any ${c.relationship}` };
      }
      case "protects": {
        const holders = (await items(c.type)).filter((o) => o.values[c.property] !== undefined);
        if (holders.length === 0) return { passed: undefined, detail: `the source returned no ${c.property} on any ${c.type}, so there was nothing to withhold` };
        const seen = await runtime.getObject(c.type, holders[0]!.objectId, env.without(c.policy));
        const hidden = seen.values[c.property] === undefined;
        return { passed: hidden, detail: hidden ? `withheld without ${c.policy}` : `shown without ${c.policy}` };
      }
      case "marks": {
        const holders = (await items(c.type)).filter((o) => o.values[c.property] !== undefined);
        if (holders.length === 0) return { passed: undefined, detail: `the source returned no ${c.property} on any ${c.type}, so there was nothing to mark` };
        const levels = (env.everything.clearance && "levels" in DEMO_LINEAR_CLASSIFICATION ? DEMO_LINEAR_CLASSIFICATION.levels : []);
        const below = levels[Math.max(0, levels.indexOf(c.marking) - 1)];
        if (!below || below === c.marking) return { passed: undefined, detail: `no level below ${c.marking} to read as` };
        try {
          const seen = await runtime.getObject(c.type, holders[0]!.objectId, env.clearedTo(below));
          const hidden = seen.values[c.property] === undefined;
          return { passed: hidden, detail: hidden ? `withheld from ${below}` : `shown to ${below}` };
        } catch (e) {
          if (e instanceof AuthorizationError) return { passed: false, detail: `the whole ${c.type} was refused to ${below}, not just ${c.property}` };
          throw e;
        }
      }
    }
  }
}

const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
