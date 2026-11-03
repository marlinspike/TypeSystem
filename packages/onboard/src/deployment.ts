import { randomBytes } from "node:crypto";
import type { PackArchive } from "@typesys/packs";
import type { AdapterPlan } from "./build.js";

/**
 * A deployment document drafted from an onboarding run (ADR-0111): what
 * `typesys init --from postgres` writes and `typesys onboard propose
 * --deployment` keeps current. It is plain data in the generic host's
 * `typesys.deployment/1` format; this package writes it and never imports
 * the host, which checks it when it is built.
 */
export interface DraftDeployment {
  readonly format: "typesys.deployment/1";
  readonly name: string;
  readonly description?: string;
  readonly demo?: boolean;
  readonly packs: readonly { readonly name: string; readonly version: string; readonly digest?: string; readonly file?: string }[];
  readonly sources: Readonly<Record<string, unknown>>;
  readonly policies: Readonly<Record<string, unknown>>;
  readonly identity: unknown;
  readonly personas?: Readonly<Record<string, { readonly subjectId: string; readonly roles: readonly string[]; readonly attributes: Readonly<Record<string, unknown>> }>>;
  readonly [key: string]: unknown;
}

/** The rules a pack names, by what they decide. */
export interface PackRules {
  /** A Type's `objectPolicy`: who may read its objects at all. */
  readonly read: readonly string[];
  /** A property's or relationship's own policy: who may see that part. */
  readonly sensitive: readonly string[];
  /** An Action's `authorizationPolicy`: who may invoke it. */
  readonly invoke: readonly string[];
}

/** The roles a drafted deployment grants each kind of rule to, and the personas that hold them. */
export const DRAFT_ROLES = { read: "reader", sensitive: "steward", invoke: "operator" } as const;

/** Every policy rule a pack names, sorted into what each decides. A rule named in two places is given its widest role, `read` before `sensitive` before `invoke`. */
export function packRules(pack: PackArchive): PackRules {
  const read = new Set<string>();
  const sensitive = new Set<string>();
  const invoke = new Set<string>();
  for (const t of pack.contents.types) {
    const policy = (t.schema as { "x-policy"?: { objectPolicy?: string; propertyPolicies?: Record<string, string> } })["x-policy"];
    if (policy?.objectPolicy) read.add(policy.objectPolicy);
    for (const p of Object.values(policy?.propertyPolicies ?? {})) sensitive.add(p);
    const relationships = (t.schema as { "x-relationships"?: Record<string, { policy?: string }> })["x-relationships"] ?? {};
    for (const r of Object.values(relationships)) if (r.policy) sensitive.add(r.policy);
  }
  for (const a of pack.contents.actions) if (a.authorizationPolicy) invoke.add(a.authorizationPolicy);
  // Any other rule the pack requires (a precondition's, say) is the steward's until someone writes it.
  for (const p of pack.requirements.policies) if (!read.has(p) && !invoke.has(p)) sensitive.add(p);
  for (const p of read) sensitive.delete(p);
  for (const p of read) invoke.delete(p);
  for (const p of sensitive) invoke.delete(p);
  const sorted = (s: Set<string>) => [...s].sort();
  return { read: sorted(read), sensitive: sorted(sensitive), invoke: sorted(invoke) };
}

/** The rule a drafted deployment starts each policy with: the kind's role (ADR-0111). Nothing is `"always"`. */
export function draftPolicy(kind: keyof PackRules): { readonly role: readonly string[] } {
  if (kind === "read") return { role: [DRAFT_ROLES.read] };
  if (kind === "sensitive") return { role: [DRAFT_ROLES.sensitive] };
  return { role: [DRAFT_ROLES.invoke] };
}

/** A `postgres` source of the host's format, from an onboarding plan, its connection string read from `connectionEnv`. */
function sourceOf(plan: Extract<AdapterPlan, { kind: "postgres-table" }>, connectionEnv: string): Record<string, unknown> {
  return { kind: "postgres", system: plan.system, url: { $secret: connectionEnv }, types: plan.types };
}

const token = (persona: string): string => `dev-${persona}-${randomBytes(9).toString("base64url")}`;

export interface DraftOptions {
  /** The deployment's name. */
  readonly name: string;
  /** Where the pack archive is, relative to the deployment file. */
  readonly packFile: string;
  /** The variable each Postgres source's connection string is read from, by data source id. Default: the plan's. */
  readonly connectionEnv?: Readonly<Record<string, string>>;
  /** Makes a persona's token. Default: `dev-<persona>-<random>`, so no two drafts share one. */
  readonly token?: (persona: string) => string;
}

export interface DraftResult {
  readonly deployment: DraftDeployment;
  readonly rules: PackRules;
  /** Each persona's token, as the deployment's `identity.tokens` maps it. */
  readonly tokens: Readonly<Record<string, string>>;
}

/**
 * The deployment a newly onboarded database starts from (ADR-0111). A demo
 * deployment, so it serves on a developer's machine with fixed tokens and
 * no identity provider; its rules give each kind of rule one role, so the
 * first read already shows governance: a `reader` reads every Type but no
 * sensitive part of one, a `steward` sees those too, an `operator` may
 * invoke Actions, and anyone else is refused. Every source's mapping is the
 * one onboarding verified, and the pack is listed with its digest.
 */
export function draftDeployment(pack: PackArchive, plans: readonly AdapterPlan[], opts: DraftOptions): DraftResult {
  const rules = packRules(pack);
  const policies: Record<string, unknown> = {};
  for (const kind of ["read", "sensitive", "invoke"] as const) for (const r of rules[kind]) policies[r] = draftPolicy(kind);
  const sources: Record<string, unknown> = {};
  for (const plan of plans) {
    if (plan.kind !== "postgres-table") throw new Error(`${plan.dataSourceId} is a ${plan.kind} source: typesys init drafts deployments for PostgreSQL sources only`);
    sources[plan.dataSourceId] = sourceOf(plan, opts.connectionEnv?.[plan.dataSourceId] ?? plan.connectionEnv);
  }
  const personas: Record<string, { subjectId: string; roles: string[]; attributes: Record<string, unknown> }> = {
    reader: { subjectId: "dev-reader", roles: [DRAFT_ROLES.read], attributes: {} },
    steward: { subjectId: "dev-steward", roles: [DRAFT_ROLES.read, DRAFT_ROLES.sensitive], attributes: {} }
  };
  if (rules.invoke.length > 0) personas.operator = { subjectId: "dev-operator", roles: [DRAFT_ROLES.read, DRAFT_ROLES.invoke], attributes: {} };
  const make = opts.token ?? token;
  const tokens: Record<string, string> = Object.fromEntries(Object.keys(personas).map((p) => [p, make(p)]));
  const deployment: DraftDeployment = {
    format: "typesys.deployment/1",
    name: opts.name,
    description: `${pack.description}. Drafted by typesys init: a development deployment with fixed tokens; see README.md before serving it to anyone else.`,
    demo: true,
    packs: [{ name: pack.name, version: pack.version, digest: pack.digest, file: opts.packFile }],
    sources,
    policies,
    identity: { kind: "tokens", tokens: Object.fromEntries(Object.entries(tokens).map(([p, t]) => [t, p])) },
    personas
  };
  return { deployment, rules, tokens };
}

export interface DeploymentUpdate {
  readonly deployment: DraftDeployment;
  /** Policy rules the new pack names that the deployment had none for: each added with its kind's draft rule. */
  readonly addedPolicies: readonly string[];
  /** Rules the deployment has that the new pack no longer names: kept, for a person to remove. */
  readonly unusedPolicies: readonly string[];
  /** What else changed, in words. */
  readonly changes: readonly string[];
}

/**
 * The deployment with a re-onboarded pack in it (ADR-0111): the pack's
 * version, digest and file, each Postgres source's mapping replaced by the
 * one onboarding just verified (its connection reference kept), and a draft
 * rule for every rule the pack now names that the deployment lacks. A rule
 * the deployment already has is never changed, and one the pack no longer
 * names is kept and reported.
 */
export function updateDeployment(existing: DraftDeployment, pack: PackArchive, plans: readonly AdapterPlan[], packFile: string): DeploymentUpdate {
  const changes: string[] = [];
  const at = existing.packs.findIndex((p) => p.name === pack.name);
  const ref = { name: pack.name, version: pack.version, digest: pack.digest, file: packFile };
  const packs = at < 0 ? [...existing.packs, ref] : existing.packs.map((p, i) => (i === at ? ref : p));
  const before = at < 0 ? undefined : existing.packs[at];
  if (!before) changes.push(`pack ${pack.name}@${pack.version} added`);
  else if (before.version !== pack.version || before.digest !== pack.digest) changes.push(`pack ${pack.name} ${before.version} → ${pack.version} (${pack.digest.slice(0, 19)}…)`);
  const sources: Record<string, unknown> = { ...existing.sources };
  for (const plan of plans) {
    if (plan.kind !== "postgres-table") continue;
    const current = sources[plan.dataSourceId] as { kind?: string; url?: unknown } | undefined;
    if (current && current.kind !== "postgres") throw new Error(`sources["${plan.dataSourceId}"] is a ${String(current.kind)} source in the deployment, and onboarding read it as PostgreSQL`);
    const next = sourceOf(plan, plan.connectionEnv);
    if (current?.url !== undefined) next.url = current.url;
    if (JSON.stringify(current) !== JSON.stringify({ ...current, ...next })) changes.push(`sources["${plan.dataSourceId}"]: mapping ${current ? "updated" : "added"}`);
    sources[plan.dataSourceId] = { ...current, ...next };
  }
  const rules = packRules(pack);
  const policies: Record<string, unknown> = { ...existing.policies };
  const addedPolicies: string[] = [];
  for (const kind of ["read", "sensitive", "invoke"] as const) {
    for (const r of rules[kind]) {
      if (Object.hasOwn(policies, r)) continue;
      policies[r] = draftPolicy(kind);
      addedPolicies.push(r);
    }
  }
  const named = new Set([...rules.read, ...rules.sensitive, ...rules.invoke]);
  const prefix = `${pack.name}.`;
  const unusedPolicies = Object.keys(existing.policies).filter((r) => r.startsWith(prefix) && !named.has(r));
  return { deployment: { ...existing, packs, sources, policies }, addedPolicies, unusedPolicies, changes };
}
