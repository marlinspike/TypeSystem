import {
  AuthorizationError,
  ContractUnsatisfiedError,
  NotFoundError,
  canonical,
  comparePolicies,
  compilePolicies,
  describeWitness,
  PolicyNotComparableError,
  PolicyTooLargeError,
  comparePolicyRules,
  contractMismatches,
  describeModel,
  requireRole,
  type ContractMismatch,
  type PolicyExpression,
  type Identity,
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
 * - a policy that now admits a persona it refused, on any Type;
 * - a policy that now admits anyone it refused, decided exactly over every
 *   request rather than the personas (ADR-0109), where the rule decides
 *   something: a rule changed in place, or a Type, property or Action that
 *   now names another rule;
 * - an audit trail that was kept and signed and now is not (ADR-0106).
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
  /** `absent`: the policy is not in that build; a Type that names it is refused (default deny). */
  readonly before: boolean | "throws" | "absent";
  readonly after: boolean | "throws" | "absent";
}

/** A rule's change decided over every request (ADR-0109), not only the personas'. */
export interface ExactPolicyChange {
  readonly policy: string;
  /** For a Type, property or Action that now names another rule: what it names, and what it named. */
  readonly slot?: { readonly decides: string; readonly before: string };
  /** What it now decides, as the new build's inspection reports it. */
  readonly decides: readonly string[];
  readonly widens: readonly string[];
  readonly narrows: readonly string[];
  /** Too large to enumerate: compared by personas only. */
  readonly tooLarge?: boolean;
  /** Why the change could not be compared exactly, when not for size. */
  readonly notComparable?: string;
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
  readonly policies: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
    readonly decisions: readonly PolicyDecisionChange[];
    readonly exact: readonly ExactPolicyChange[];
  };
  /** Where each build keeps its audit trail, workflow runs, cache and rate budget (ADR-0106). */
  readonly state: { readonly before: Readonly<Record<string, string>>; readonly after: Readonly<Record<string, string>> };
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
    actor: CHECKER.subjectId,
    // The check writes nothing anywhere: its probes are audited in memory, never into the deployment's own trail (ADR-0106).
    state: "memory"
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
    const [baseA, baseB] = [await record(a), await record(b)];
    const impact = analyzeChange(baseA, baseB, opts.graphConsumers ?? []);

    // Policies, as data and as decisions: each persona, on each Type the policy decides in either build (its own
    // Type, a member's, or an Action's), type-level. A rule decides nothing where no Type names it.
    const ruleDiff = diffNamed(new Map(Object.entries(a.deployment.policies)), new Map(Object.entries(b.deployment.policies)), sameJson);
    const actionTypes = new Map([...baseA.description.actions, ...baseB.description.actions].map((x) => [x.name, x.applicableTypes]));
    const decidedTypes = new Map<string, Set<string>>();
    for (const p of [...(baseA.inspection?.policies ?? []), ...(baseB.inspection?.policies ?? [])]) {
      const set = decidedTypes.get(p.name) ?? new Set<string>();
      for (const d of p.decides) {
        if (actionTypes.has(d)) for (const t of actionTypes.get(d)!) set.add(t);
        else set.add(types.find((t) => d === t || d.startsWith(`${t}.`)) ?? d);
      }
      decidedTypes.set(p.name, set);
    }
    const [rulesA, rulesB] = [compilePolicies(a.deployment.policies), compilePolicies(b.deployment.policies)];
    const decisions: PolicyDecisionChange[] = [];
    for (const policy of [...new Set([...Object.keys(rulesA), ...Object.keys(rulesB)])].sort()) {
      const on = [...(decidedTypes.get(policy) ?? [])].sort();
      const requests = Object.entries(personas).flatMap(([as, subject]) => on.map((type) => ({ as, subject, action: "read" as const, resource: { typeName: type } })));
      if (requests.length === 0) continue;
      const one = (rules: typeof rulesA) => (Object.hasOwn(rules, policy) ? { [policy]: rules[policy]! } : {});
      const [onlyA, onlyB] = [one(rulesA), one(rulesB)];
      const absent = { [policy]: (() => Promise.resolve({ allow: false })) as (typeof rulesA)[string] };
      const diffs = await comparePolicyRules(Object.keys(onlyA).length ? onlyA : absent, Object.keys(onlyB).length ? onlyB : absent, requests, { [policy]: ["reason", "plan", "description"] });
      for (const d of diffs) {
        if (d.what !== "decision") continue;
        const r = requests[d.request]!;
        decisions.push({
          policy,
          as: r.as,
          type: r.resource.typeName,
          before: Object.keys(onlyA).length ? (d.before as boolean | "throws") : "absent",
          after: Object.keys(onlyB).length ? (d.after as boolean | "throws") : "absent"
        });
      }
    }

    // Exact (ADR-0109): each rule changed in place, and each slot that now names another rule, over every request.
    const exprA = a.deployment.policies;
    const exprB = b.deployment.policies;
    const decidesIn = (inspection: Baseline["inspection"], deployment: Deployment) => {
      const bySlot = new Map<string, string>();
      for (const p of inspection?.policies ?? []) for (const d of p.decides) bySlot.set(d, p.name);
      // Who may explain another subject's access is decided by a rule too, though not on a Type (ADR-0089).
      if (deployment.runtime?.inspectionPolicy !== undefined) bySlot.set("runtime.inspectionPolicy", deployment.runtime.inspectionPolicy);
      return bySlot;
    };
    const [slotsA, slotsB] = [decidesIn(baseA.inspection, a.deployment), decidesIn(baseB.inspection, b.deployment)];
    const decidesB = new Map<string, string[]>();
    for (const [slot, policy] of slotsB) decidesB.set(policy, [...(decidesB.get(policy) ?? []), slot]);
    const exact: ExactPolicyChange[] = [];
    const compare = async (policy: string, before: PolicyExpression | undefined, after: PolicyExpression | undefined, slot?: ExactPolicyChange["slot"]) => {
      const decides = slot ? [slot.decides] : [...(decidesB.get(policy) ?? [])].sort();
      try {
        const r = await comparePolicies(before, after);
        if (r.widens.length + r.narrows.length > 0) exact.push({ policy, ...(slot ? { slot } : {}), decides, widens: r.widens.map(describeWitness), narrows: r.narrows.map(describeWitness) });
      } catch (err) {
        if (!(err instanceof PolicyNotComparableError)) throw err;
        exact.push({ policy, ...(slot ? { slot } : {}), decides, widens: [], narrows: [], ...(err instanceof PolicyTooLargeError ? { tooLarge: true } : { notComparable: err.message }) });
      }
    };
    for (const policy of [...ruleDiff.changed, ...ruleDiff.added].sort()) await compare(policy, Object.hasOwn(exprA, policy) ? exprA[policy] : undefined, exprB[policy]);
    for (const [slot, policy] of [...slotsB].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const was = slotsA.get(slot);
      if (was === undefined || was === policy || !Object.hasOwn(exprB, policy) || !Object.hasOwn(exprA, was)) continue;
      await compare(policy, exprA[was], exprB[policy], { decides: slot, before: was });
    }

    const packDiff = diffNamed(keyed(a.packs, (p) => p.name), keyed(b.packs, (p) => p.name), (x, y) => x.digest === y.digest && x.version === y.version);
    const sourceDiff = diffNamed(new Map(Object.entries(a.deployment.sources)), new Map(Object.entries(b.deployment.sources)), sameJson);
    const settings = (["classification", "identity", "personas", "runtime", "trust", "extensions", "demo", "state", "applications"] as const).filter((k) => !sameJson(a.deployment[k], b.deployment[k]));
    const stateOf = (d: typeof a.deployment) => ({
      audit: d.state?.audit?.kind ?? "memory",
      signed: d.state?.audit?.signing ? "yes" : "no",
      workflows: d.state?.workflows?.kind ?? "memory",
      cache: d.state?.cache?.kind ?? "none",
      rateLimit: d.state?.rateLimit?.kind ?? "none"
    });
    const [stateA, stateB] = [stateOf(a.deployment), stateOf(b.deployment)];

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
    for (const e of impact.exposures) blocking.push(`exposure: ${e.as} reads ${e.subject} on ${e.object ?? e.subject} (${e.change})`);
    for (const q of queries.filter((x) => x.effect === "widens")) blocking.push(`exposure: ${q.as} gets more from query ${q.query} (${q.before.outcome}${q.before.values ? ` [${q.before.values.join(", ")}]` : ""} → ${q.after.outcome}${q.after.values ? ` [${q.after.values.join(", ")}]` : ""})`);
    const admits = new Map<string, string[]>();
    for (const d of decisions.filter((x) => x.after === true && x.before !== true)) admits.set(`${d.policy}|${d.as}`, [...(admits.get(`${d.policy}|${d.as}`) ?? []), d.type]);
    for (const [k, on] of admits) {
      const [policy, as] = k.split("|");
      blocking.push(`policy ${policy} now admits ${as} (on ${on.join(", ")})`);
    }

    for (const e of exact) {
      // A rule that decides nothing in the new build admits nobody to anything: listed, not blocking.
      if (e.decides.length === 0) continue;
      const at = e.slot ? `${e.slot.decides} now names ${e.policy} instead of ${e.slot.before}` : `policy ${e.policy} (deciding ${e.decides.join(", ")})`;
      // Fail closed: a change that cannot be compared is not known not to widen.
      if (e.tooLarge) blocking.push(`unverified: ${at} is too large to compare exactly (over 4,096 conjunctions); split it or review it by hand`);
      if (e.notComparable) blocking.push(`unverified: ${at} could not be compared exactly (${e.notComparable}); review it by hand`);
      for (const w of e.widens) blocking.push(`widens: ${at} now admits ${w}`);
    }
    if (stateA.audit === "postgres" && stateB.audit !== "postgres") blocking.push("state: the audit trail would no longer be kept: state.audit was postgres");
    if (stateA.signed === "yes" && stateB.signed !== "yes") blocking.push("state: audit checkpoints would no longer be signed");
    if (stateA.workflows === "postgres" && stateB.workflows !== "postgres") blocking.push("state: workflow runs and approvals would no longer be kept: state.workflows was postgres");
    if (a.deployment.runtime?.securityProfile !== undefined && b.deployment.runtime?.securityProfile !== a.deployment.runtime.securityProfile)
      blocking.push(`runtime: the security profile ${a.deployment.runtime.securityProfile} would no longer apply`);
    // A verify key dropped turns every checkpoint it signed into an unknown-key problem: rotate by adding, never by removing.
    const keysA = a.deployment.state?.audit?.verifyKeys ?? {};
    const keysB = b.deployment.state?.audit?.verifyKeys ?? {};
    for (const id of Object.keys(keysA).sort()) if (!Object.hasOwn(keysB, id) || keysB[id] !== keysA[id]) blocking.push(`state: audit verify key ${id} would be ${Object.hasOwn(keysB, id) ? "replaced" : "removed"}; checkpoints it signed would no longer verify`);
    if (stateA.rateLimit !== "none" && stateB.rateLimit === "none") blocking.push(`state: callers would no longer be rate limited: state.rateLimit was ${stateA.rateLimit}`);
    else if (stateA.rateLimit === "redis" && stateB.rateLimit === "memory") blocking.push("state: the rate limit would no longer be shared: each replica would admit the whole budget (state.rateLimit was redis)");

    const changed =
      blocking.length > 0 ||
      exact.length > 0 ||
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
      policies: { ...ruleDiff, decisions, exact },
      state: { before: stateA, after: stateB },
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
  const accepted = (r as Partial<AcceptedReport>).accepted ?? [];
  lines.push(
    r.ok
      ? accepted.length
        ? `OK: ${accepted.length} blocking change${accepted.length === 1 ? "" : "s"} accepted, nothing else blocks this upgrade.`
        : "OK: nothing blocks this upgrade."
      : `BLOCKED: ${r.blocking.length} reason${r.blocking.length === 1 ? "" : "s"} this must not roll as is.`
  );
  for (const b of r.blocking) lines.push(`  ✗ ${b}`);
  for (const a of accepted) lines.push(`  ✓ accepted by ${a.by} (${a.why}): ${a.blocking}`);
  if (!r.ok && accepted.length === 0 && r.blocking.length > 0) lines.push("  If this is meant: write an acceptance with --write-acceptance <file> --by <name> --why <reason>, review it, and pass it with --accept <file>.");
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
  const byRule = new Map<string, { before: string; after: string; on: string[] }>();
  for (const d of r.policies.decisions) {
    const k = `${d.policy}|${d.as}|${String(d.before)}|${String(d.after)}`;
    byRule.set(k, { before: String(d.before), after: String(d.after), on: [...(byRule.get(k)?.on ?? []), d.type] });
  }
  for (const [k, v] of byRule) {
    const [policy, as] = k.split("|");
    lines.push(`  ${policy} for ${as}: ${v.before === "true" ? "admitted" : v.before === "false" ? "refused" : v.before} → ${v.after === "true" ? "admitted" : v.after === "false" ? "refused" : v.after} (on ${v.on.join(", ")})`);
  }
  for (const e of r.policies.exact) {
    const at = e.slot ? `${e.slot.decides}: ${e.slot.before} → ${e.policy}` : e.policy;
    if (e.tooLarge) lines.push(`  ${at}: too large to compare exactly; compared by personas only, and blocking`);
    if (e.notComparable) lines.push(`  ${at}: not compared exactly (${e.notComparable}); blocking`);
    for (const w of e.widens) lines.push(`  ${at} [widens, exact] ${w}`);
    for (const n of e.narrows) lines.push(`  ${at} [narrows, exact] ${n}`);
  }
  if (r.settings.length) lines.push(`Settings changed: ${r.settings.join(", ")}`);
  const stateChanges = Object.keys(r.state.after).filter((k) => r.state.before[k] !== r.state.after[k]);
  if (stateChanges.length) lines.push(`State: ${stateChanges.map((k) => `${k} ${r.state.before[k]} → ${r.state.after[k]}`).join(", ")}`);
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
    // Every widening, one line each; the rest counted per persona, which is what a reviewer weighs.
    for (const i of observed.filter((x) => x.effect === "widens")) lines.push(`  [widens] ${i.as} reads ${i.subject} on ${i.object}: ${i.change}`);
    const rest = new Map<string, { n: number; objects: Set<string> }>();
    for (const i of observed.filter((x) => x.effect !== "widens")) {
      const k = `${i.effect ?? "changes"}|${i.as ?? "?"}`;
      const e = rest.get(k) ?? { n: 0, objects: new Set<string>() };
      e.n++;
      if (i.object) e.objects.add(i.object);
      rest.set(k, e);
    }
    for (const [k, e] of rest) {
      const [effect, as] = k.split("|");
      lines.push(`  [${effect}] ${as}: ${e.n} value${e.n === 1 ? "" : "s"} on ${e.objects.size} object${e.objects.size === 1 ? "" : "s"}`);
    }
  }
  for (const q of r.queries) lines.push(`Query ${q.query} as ${q.as}: [${q.effect}] ${q.before.outcome} (${q.before.count ?? 0}) → ${q.after.outcome} (${q.after.count ?? 0})`);
  if (r.impact.checks.length) lines.push(`Acceptance checks to run: ${r.impact.checks.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * A reviewer's acceptance of what an upgrade check blocks on (ADR-0114):
 * each blocking line, exactly as the check printed it, with who accepted it
 * and why, for one pair of builds. A deliberate change (a rule that is meant
 * to admit a new role) then passes the check without the check being turned
 * off, and the acceptance is a file a pull request carries for review.
 */
export const DEPLOY_ACCEPTANCE_FORMAT = "typesys.deploy-acceptance/1";

export interface DeployAcceptance {
  readonly format: typeof DEPLOY_ACCEPTANCE_FORMAT;
  /** The build being replaced and the build replacing it: an acceptance answers for this change and no other. */
  readonly from: string;
  readonly to: string;
  readonly accepted: readonly { readonly blocking: string; readonly by: string; readonly why: string }[];
}

/** An acceptance of every line `report` blocks on, by one reviewer for one reason: what `--write-acceptance` writes. */
export function acceptanceFor(report: DeployCheckReport, by: string, why: string): DeployAcceptance {
  if (!by.trim()) throw new Error("an acceptance names who accepted it (--by)");
  if (!why.trim()) throw new Error("an acceptance says why the change is meant (--why)");
  return { format: DEPLOY_ACCEPTANCE_FORMAT, from: report.before.build, to: report.after.build, accepted: report.blocking.map((blocking) => ({ blocking, by, why })) };
}

/** Every problem with an acceptance document's shape. */
export function validateAcceptance(doc: unknown): string[] {
  const d = doc as Partial<DeployAcceptance> | null;
  if (typeof d !== "object" || d === null || d.format !== DEPLOY_ACCEPTANCE_FORMAT) return [`must be a ${DEPLOY_ACCEPTANCE_FORMAT} document (write one with typesys deploy check ... --write-acceptance <file> --by <name> --why <reason>)`];
  const out: string[] = [];
  if (typeof d.from !== "string" || typeof d.to !== "string") out.push("from and to: must be the two build ids");
  if (!Array.isArray(d.accepted)) out.push("accepted: must be a list");
  else
    (d.accepted as readonly (Partial<DeployAcceptance["accepted"][number]> | null)[]).forEach((a, i) => {
      if (typeof a?.blocking !== "string" || typeof a.by !== "string" || !a.by.trim() || typeof a.why !== "string" || !a.why.trim()) out.push(`accepted[${i}]: needs blocking, by and why`);
    });
  return out;
}

export interface AcceptedReport extends DeployCheckReport {
  /** The blocking lines a reviewer accepted, with who and why. */
  readonly accepted: DeployAcceptance["accepted"];
}

/**
 * The report with an acceptance applied (ADR-0114). It passes only when
 * every blocking line is accepted, exactly, for these two builds. An
 * acceptance for other builds is refused whole, and an accepted line the
 * check no longer blocks on is itself a reason to block: the change it
 * answered for is not this one.
 */
export function applyAcceptance(report: DeployCheckReport, acceptance: DeployAcceptance): AcceptedReport {
  const blocking: string[] = [];
  if (acceptance.from !== report.before.build || acceptance.to !== report.after.build) {
    blocking.push(...report.blocking, `acceptance: it is for ${acceptance.from.slice(0, 19)}… → ${acceptance.to.slice(0, 19)}…, not this change (${report.before.build.slice(0, 19)}… → ${report.after.build.slice(0, 19)}…); write it again for this one`);
    return { ...report, ok: false, blocking, accepted: [] };
  }
  const by = new Map(acceptance.accepted.map((a) => [a.blocking, a]));
  const accepted: DeployAcceptance["accepted"][number][] = [];
  for (const line of report.blocking) {
    const a = by.get(line);
    if (a) accepted.push(a);
    else blocking.push(line);
  }
  const current = new Set(report.blocking);
  for (const a of acceptance.accepted) if (!current.has(a.blocking)) blocking.push(`acceptance: accepts "${a.blocking}", which this check does not block on; remove it or write the acceptance again`);
  return { ...report, ok: blocking.length === 0, blocking, accepted };
}
