import {
  AuthorizationError,
  ContractUnsatisfiedError,
  NotFoundError,
  canonical,
  compilePolicies,
  comparePolicyRules,
  contractMismatches,
  describeModel,
  requireRole,
  type ContractMismatch,
  type Identity,
  type PolicyRequest,
  type SemanticQuery
} from "@typesys/core";
import { analyzeChange, recordBaseline, type Baseline, type ChangeImpact, type GraphConsumer } from "@typesys/devkit";
import type { PackArchive } from "@typesys/packs";
import type { ConsumerSpec, Deployment } from "./deployment.js";
import { buildHost, type Host, type HostEnvironment, type HostExtension } from "./host.js";

/**
 * The upgrade check (ADR-0104): what rolling `after` in place of `before`
 * would change, decided by building both, in this process, and asking them
 * the same questions. Nothing is written to either deployment's systems:
 * every probe is a read, explained as each persona would make it.
 *
 * It reports, and blocks on (exit 1 from `typesys deploy check`):
 * - a consumer whose contract the new build does not keep (ADR-0103);
 * - a breaking change to the model's contract (ADR-0056);
 * - an exposure: a persona who may now read a value, or run a query, that
 *   they could not before (ADR-0093's observed changes, plus the queries given);
 * - a policy that now admits a persona it refused, on any Type.
 * Everything else that changed (packs, sources, policies that narrow,
 * classification, identity) is listed for review without blocking.
 */
export const DEPLOY_CHECK_FORMAT = "typesys.deploy-check/1";

export interface DeploymentBuild {
  readonly deployment: Deployment;
  readonly packs: readonly PackArchive[];
  readonly extensions?: readonly HostExtension[];
  readonly env?: HostEnvironment;
}

export interface DeployCheckOptions {
  /** Personas whose reads are compared, by name. Default: every persona either deployment declares (and `anonymous`). */
  readonly personas?: readonly string[];
  /** Objects probed beside the first `probe` each persona may read of each Type: the ones a policy treats differently. */
  readonly objects?: readonly { readonly type: string; readonly id: string }[];
  /** Objects of each Type found per persona to probe. Default 2. */
  readonly probe?: number;
  /** Queries a consumer depends on, run as every persona against both builds: outcomes, counts and which values came back, never the values. */
  readonly queries?: readonly SemanticQuery[];
  /** Consumers to check beside those the new deployment declares (an application's `contract.json`). */
  readonly consumers?: readonly ConsumerSpec[];
  /** What consumes the model, for what each change reaches (`appUses`, `workflowUses`). */
  readonly graphConsumers?: readonly GraphConsumer[];
}

export interface QueryOutcome {
  readonly outcome: "ok" | "refused" | "not-found" | "unavailable" | "contract-unsatisfied";
  readonly count?: number;
  /** Every value name returned on any object, sorted. */
  readonly values?: readonly string[];
}

export interface QueryDifference {
  readonly query: number;
  readonly as: string;
  readonly before: QueryOutcome;
  readonly after: QueryOutcome;
  /** `widens`: the persona now gets something they did not (a result, a value). */
  readonly effect: "widens" | "narrows" | "changes";
}

export interface PolicyDecisionChange {
  readonly policy: string;
  readonly as: string;
  readonly type: string;
  readonly before: boolean | "throws" | "absent";
  readonly after: boolean | "throws" | "absent";
}

export interface DeployCheckReport {
  readonly format: typeof DEPLOY_CHECK_FORMAT;
  readonly before: { readonly name: string; readonly build: string };
  readonly after: { readonly name: string; readonly build: string };
  /** Nothing changed that a consumer, a persona or a reviewer must look at. */
  readonly ok: boolean;
  /** Why it must not roll as is, one line each. Empty when it may. */
  readonly blocking: readonly string[];
  readonly packs: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] };
  readonly sources: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] };
  readonly policies: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[]; readonly decisions: readonly PolicyDecisionChange[] };
  /** Other settings that changed: classification, identity, personas, runtime, trust, extensions. */
  readonly settings: readonly string[];
  readonly consumers: readonly { readonly name: string; readonly satisfied: boolean; readonly mismatches: readonly ContractMismatch[] }[];
  /** The model's contract, its governance, and each persona's probed reads (ADR-0093). */
  readonly impact: ChangeImpact;
  readonly queries: readonly QueryDifference[];
}

/** Who the check records as: it may inspect both builds, and nothing else (an inspection rule only this check holds). */
const CHECKER: Identity = Object.freeze({ subjectId: "typesys-deploy-check", roles: ["typesys-deploy-check"], attributes: {} });
const INSPECT_RULE = "typesys.deploy-check.inspect";

async function buildForCheck(b: DeploymentBuild): Promise<Host> {
  return buildHost(b.deployment, {
    packs: b.packs,
    ...(b.extensions ? { extensions: b.extensions } : {}),
    ...(b.env ? { env: b.env } : {}),
    // The check inspects both builds as itself: a rule beside the deployment's, under a name no deployment may use.
    policyRules: { [INSPECT_RULE]: requireRole(CHECKER.roles[0]!) },
    runtimeOptions: { inspection: { policy: INSPECT_RULE } },
    actor: CHECKER.subjectId
  });
}

const keyed = <T>(items: readonly T[], key: (t: T) => string): Map<string, T> => new Map(items.map((i) => [key(i), i]));

function diffNamed<T>(before: ReadonlyMap<string, T>, after: ReadonlyMap<string, T>, same: (a: T, b: T) => boolean) {
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed = [...after.keys()].filter((k) => before.has(k) && !same(before.get(k)!, after.get(k)!)).sort();
  return { added, removed, changed };
}

const sameJson = (a: unknown, b: unknown): boolean => canonical(JSON.parse(JSON.stringify(a ?? null)) as unknown) === canonical(JSON.parse(JSON.stringify(b ?? null)) as unknown);

async function outcomeOf(host: Host, query: SemanticQuery, who: Identity): Promise<QueryOutcome> {
  try {
    const { items } = await host.runtime.query(query, who);
    return { outcome: "ok", count: items.length, values: [...new Set(items.flatMap((o) => Object.keys(o.values)))].sort() };
  } catch (err) {
    if (err instanceof AuthorizationError) return { outcome: "refused" };
    if (err instanceof NotFoundError) return { outcome: "not-found" };
    if (err instanceof ContractUnsatisfiedError) return { outcome: "contract-unsatisfied" };
    return { outcome: "unavailable" };
  }
}

function queryEffect(a: QueryOutcome, b: QueryOutcome): QueryDifference["effect"] | undefined {
  if (a.outcome === "unavailable" || b.outcome === "unavailable") return undefined; // a failure decided nothing
  if (a.outcome !== b.outcome) return b.outcome === "ok" ? "widens" : a.outcome === "ok" ? "narrows" : "changes";
  if (a.outcome !== "ok") return undefined;
  const gained = (b.values ?? []).some((v) => !(a.values ?? []).includes(v));
  const lost = (a.values ?? []).some((v) => !(b.values ?? []).includes(v));
  if (gained) return "widens";
  if (lost || (b.count ?? 0) < (a.count ?? 0)) return "narrows";
  if ((b.count ?? 0) > (a.count ?? 0)) return "widens";
  return undefined;
}

/** Builds both deployments, compares them as described above, and closes both. */
export async function checkDeployment(before: DeploymentBuild, after: DeploymentBuild, opts: DeployCheckOptions = {}): Promise<DeployCheckReport> {
  const hosts: Host[] = [];
  try {
    const a = await buildForCheck(before);
    hosts.push(a);
    const b = await buildForCheck(after);
    hosts.push(b);

    const names = opts.personas ?? [...new Set([...Object.keys(a.personas), ...Object.keys(b.personas)])].sort();
    const unknown = names.filter((n) => !Object.hasOwn(a.personas, n) && !Object.hasOwn(b.personas, n));
    if (unknown.length > 0) throw new Error(`No such persona in either deployment: ${unknown.join(", ")}`);
    // A persona is who they are in the new deployment, else the old: the same person, asking both.
    const personas: Record<string, Identity> = Object.fromEntries(names.map((n) => [n, (Object.hasOwn(b.personas, n) ? b.personas[n] : a.personas[n])!]));

    // The objects to probe: each persona's first few of each Type, in either build, plus those given.
    const types = [...new Set([...(await a.registry.listTypes()), ...(await b.registry.listTypes())].map((t) => t.name))].sort();
    const objects = new Map<string, { type: string; id: string }>();
    for (const o of opts.objects ?? []) objects.set(`${o.type}/${o.id}`, o);
    for (const host of [a, b])
      for (const type of types)
        for (const who of Object.values(personas)) {
          try {
            for (const o of (await host.runtime.query({ type, limit: opts.probe ?? 2 }, who)).items) objects.set(`${type}/${o.objectId}`, { type, id: o.objectId });
          } catch {
            // Not readable by this persona, or not in this build: nothing of it to probe from here.
          }
        }

    const record = async (host: Host): Promise<Baseline> => {
      const probed = await recordBaseline(host.runtime, CHECKER, { callers: personas, objects: [...objects.values()], probe: 0 });
      // The model as it is, not as the checker is told of it: the contract diff must see every Type.
      return { ...probed, description: await describeModel(host.registry) };
    };
    const impact = analyzeChange(await record(a), await record(b), opts.graphConsumers ?? []);

    // Policies, as data and as decisions: every persona, every Type, type-level.
    const ruleDiff = diffNamed(new Map(Object.entries(a.deployment.policies)), new Map(Object.entries(b.deployment.policies)), sameJson);
    const requests: (Omit<PolicyRequest, "policyName"> & { as: string })[] = Object.entries(personas).flatMap(([as, subject]) =>
      types.map((type) => ({ as, subject, action: "read" as const, resource: { typeName: type } }))
    );
    const diffs = await comparePolicyRules(compilePolicies(a.deployment.policies), compilePolicies(b.deployment.policies), requests, Object.fromEntries([...new Set([...Object.keys(a.deployment.policies), ...Object.keys(b.deployment.policies)])].map((p) => [p, ["reason", "plan", "description"] as const])));
    const decisions: PolicyDecisionChange[] = diffs.flatMap((d) => {
      if (d.what === "missing") return [];
      if (d.what !== "decision") return [];
      const r = requests[d.request]!;
      return [{ policy: d.policy, as: r.as, type: r.resource.typeName, before: d.before as boolean | "throws", after: d.after as boolean | "throws" }];
    });

    const packDiff = diffNamed(keyed(a.packs, (p) => p.name), keyed(b.packs, (p) => p.name), (x, y) => x.digest === y.digest && x.version === y.version);
    const sourceDiff = diffNamed(new Map(Object.entries(a.deployment.sources)), new Map(Object.entries(b.deployment.sources)), sameJson);
    const settings = (["classification", "identity", "personas", "runtime", "trust", "extensions", "demo"] as const).filter((k) => !sameJson(a.deployment[k], b.deployment[k]));

    // Consumers: the new deployment's own, and any given, against what the new build serves.
    const served = new Map((await b.registry.listTypes()).map((t) => [t.name, t.version]));
    const consumers = [...(b.deployment.consumers ?? []), ...(opts.consumers ?? [])].map((c) => {
      const mismatches = contractMismatches(c.contract, served);
      return { name: c.name, satisfied: mismatches.length === 0, mismatches };
    });

    const queries: QueryDifference[] = [];
    for (const [i, q] of (opts.queries ?? []).entries())
      for (const [as, who] of Object.entries(personas)) {
        const [qa, qb] = [await outcomeOf(a, q, who), await outcomeOf(b, q, who)];
        const effect = queryEffect(qa, qb);
        if (effect) queries.push({ query: i, as, before: qa, after: qb, effect });
      }

    const blocking: string[] = [];
    for (const c of consumers.filter((x) => !x.satisfied)) blocking.push(`consumer ${c.name}: the new build does not keep its contract (${c.mismatches.map((m) => `${m.type} ${m.range}${m.version ? `, now ${m.version}` : ", gone"}`).join("; ")})`);
    for (const item of impact.items.filter((i) => i.impact === "breaking")) blocking.push(`breaking: ${item.subject}: ${item.change}`);
    for (const e of impact.exposures) blocking.push(`exposure: ${e.as} ${e.change} on ${e.object ?? e.subject}`);
    for (const q of queries.filter((x) => x.effect === "widens")) blocking.push(`exposure: ${q.as} gets more from query ${q.query} (${q.before.outcome}${q.before.values ? ` [${q.before.values.join(", ")}]` : ""} → ${q.after.outcome}${q.after.values ? ` [${q.after.values.join(", ")}]` : ""})`);
    for (const d of decisions.filter((x) => x.after === true && x.before !== true)) blocking.push(`policy ${d.policy} now admits ${d.as} to ${d.type}`);

    const changed =
      blocking.length > 0 ||
      impact.items.length > 0 ||
      queries.length > 0 ||
      decisions.length > 0 ||
      [packDiff, sourceDiff, ruleDiff].some((x) => x.added.length + x.removed.length + x.changed.length > 0) ||
      settings.length > 0;
    return {
      format: DEPLOY_CHECK_FORMAT,
      before: { name: a.deployment.name, build: a.build },
      after: { name: b.deployment.name, build: b.build },
      ok: blocking.length === 0,
      blocking,
      packs: {
        added: packDiff.added.map((n) => `${n}@${b.packs.find((p) => p.name === n)!.version}`),
        removed: packDiff.removed.map((n) => `${n}@${a.packs.find((p) => p.name === n)!.version}`),
        changed: packDiff.changed.map((n) => `${n}: ${a.packs.find((p) => p.name === n)!.version} → ${b.packs.find((p) => p.name === n)!.version}`)
      },
      sources: sourceDiff,
      policies: { ...ruleDiff, decisions },
      settings: changed ? settings : [],
      consumers,
      impact,
      queries
    };
  } finally {
    await Promise.allSettled(hosts.map((h) => h.close()));
  }
}

/** The report as a reviewer reads it. */
export function renderDeployCheck(r: DeployCheckReport): string {
  const lines: string[] = [];
  lines.push(`${r.before.name} ${r.before.build.slice(0, 19)}… → ${r.after.name} ${r.after.build.slice(0, 19)}…`);
  lines.push(r.ok ? "OK: nothing blocks this upgrade." : `BLOCKED: ${r.blocking.length} reason${r.blocking.length === 1 ? "" : "s"} this must not roll as is.`);
  for (const b of r.blocking) lines.push(`  ✗ ${b}`);
  const list = (title: string, d: { added: readonly string[]; removed: readonly string[]; changed: readonly string[] }) => {
    if (d.added.length + d.removed.length + d.changed.length === 0) return;
    lines.push(`${title}:`);
    for (const x of d.added) lines.push(`  + ${x}`);
    for (const x of d.removed) lines.push(`  - ${x}`);
    for (const x of d.changed) lines.push(`  ~ ${x}`);
  };
  list("Packs", r.packs);
  list("Sources", r.sources);
  list("Policies", r.policies);
  for (const d of r.policies.decisions) lines.push(`  ${d.policy} for ${d.as} on ${d.type}: ${String(d.before)} → ${String(d.after)}`);
  if (r.settings.length) lines.push(`Settings changed: ${r.settings.join(", ")}`);
  for (const c of r.consumers) lines.push(`Consumer ${c.name}: ${c.satisfied ? "contract kept" : "contract NOT kept"}`);
  const contract = r.impact.items.filter((i) => i.kind === "contract");
  if (contract.length) {
    lines.push("Model contract:");
    for (const i of contract) lines.push(`  [${i.impact}] ${i.subject}: ${i.change}`);
  }
  const governance = r.impact.items.filter((i) => i.kind === "governance");
  if (governance.length) {
    lines.push("Governance:");
    for (const i of governance) lines.push(`  [${i.effect}] ${i.subject}: ${i.change}`);
  }
  const observed = r.impact.items.filter((i) => i.kind === "observed");
  if (observed.length) {
    lines.push("Observed reads:");
    for (const i of observed) lines.push(`  [${i.effect}] ${i.as} on ${i.object}: ${i.change}`);
  }
  for (const q of r.queries) lines.push(`Query ${q.query} as ${q.as}: [${q.effect}] ${q.before.outcome} (${q.before.count ?? 0}) → ${q.after.outcome} (${q.after.count ?? 0})`);
  if (r.impact.checks.length) lines.push(`Acceptance checks to run: ${r.impact.checks.join(", ")}`);
  return `${lines.join("\n")}\n`;
}
