import semver from "semver";
import { InMemoryRegistryStore, SemanticRegistry, canonical, describeModel, registerDomain, type BindingRegistry } from "@typesys/core";
import { diffModels, type ContractChange } from "@typesys/devkit";
import type { PackArchive } from "./archive.js";
import type { PackDiagnostic } from "./diagnostics.js";
import { manifestOf, planInstall } from "./install.js";

export type Bump = "major" | "minor" | "patch" | "none";

export interface UpgradeReport {
  readonly pack: string;
  readonly from: string;
  readonly to: string;
  /** Every contract change across the installed model, dependents' Types included, as the devkit classifies it (ADR-0056). */
  readonly changes: readonly ContractChange[];
  /** The smallest version bump the changes need. */
  readonly needs: Bump;
  /** The bump made. Before 1.0 a minor bump counts as major (semver item 4). */
  readonly made: Bump;
  /** Empty means the upgrade is safe to install over what is installed. */
  readonly diagnostics: readonly PackDiagnostic[];
}

const RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

function bumpOf(from: string, to: string): Bump {
  if (semver.lte(to, from)) return "none";
  if (semver.major(to) > semver.major(from)) return "major";
  if (semver.minor(to) > semver.minor(from)) return semver.major(from) === 0 ? "major" : "minor";
  return "patch";
}

/** Bindings that satisfy every key the packs name, for describing a model; none of them is ever run. */
function stubBindings(packs: readonly PackArchive[]): BindingRegistry {
  const never = (key: string) => () => Promise.reject(new Error(`binding "${key}" is a stub for describing a model and never runs`));
  return {
    computed: Object.fromEntries(packs.flatMap((p) => p.requirements.computed).map((k) => [k, never(k)])),
    preconditions: Object.fromEntries(packs.flatMap((p) => p.requirements.preconditions).map((k) => [k, never(k)]))
  };
}

async function describe(packs: readonly PackArchive[], order: readonly PackArchive[]) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const bindings = stubBindings(packs);
  for (const p of order) await registerDomain(registry, manifestOf(p, bindings));
  return describeModel(registry);
}

/** Every leaf of a protection keyword, by path: `propertyPolicies.deploymentLocation` → `airforce.maintainer-only`. */
function leaves(value: unknown, path = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) for (const [p, leaf] of leaves(v, path ? `${path}.${k}` : k)) out.set(p, leaf);
  } else if (value !== undefined) out.set(path, canonical(value));
  return out;
}

/**
 * What the contract diff cannot see, because a model description carries no
 * protections (ADR-0056): every policy and marking a Type had, every
 * Action's authorization policy, and every data source and mapping, which
 * decide where values come from. Each one removed or changed is a finding;
 * one added only tightens. A consumer's code keeps working either way, so
 * no version bump makes such a change safe; it needs a reviewer.
 */
function weakenedProtections(current: PackArchive, next: PackArchive): PackDiagnostic[] {
  const out: PackDiagnostic[] = [];
  const finding = (subject: string, message: string) => out.push({ code: "protection-weakened", pack: next.name, subject, message });
  const types = new Map(next.contents.types.map((t) => [t.name, t]));
  for (const t of current.contents.types) {
    const now = types.get(t.name);
    if (!now) continue; // A removed Type is a breaking change the contract diff reports.
    for (const keyword of ["x-policy", "x-provenance"] as const) {
      const after = leaves(now.schema[keyword]);
      for (const [path, was] of leaves(t.schema[keyword])) {
        const is = after.get(path);
        if (is !== was) finding(t.name, `${keyword} ${path} was ${was}, is ${is ?? "removed"}`);
      }
    }
  }
  const actions = new Map(next.contents.actions.map((a) => [a.name, a]));
  for (const a of current.contents.actions) {
    const now = actions.get(a.name);
    if (now && now.authorizationPolicy !== a.authorizationPolicy) finding(a.name, `authorization policy was ${a.authorizationPolicy}, is ${now.authorizationPolicy}`);
  }
  for (const [kind, before, after] of [
    ["data source", current.contents.dataSources, next.contents.dataSources],
    ["mapping", current.contents.mappings, next.contents.mappings]
  ] as const) {
    const byId = new Map<string, unknown>(after.map((x) => [x.id, x]));
    for (const x of before) {
      const now = byId.get(x.id);
      if (now === undefined) finding(x.id, `${kind} removed`);
      else if (canonical(now) !== canonical(x)) finding(x.id, `${kind} changed`);
    }
  }
  return out;
}

/**
 * Whether `next` can replace the installed version of the same pack
 * (ADR-0059), checked offline with no code run: the contract diff across
 * the whole installed model, so a change a dependent's Types inherit is
 * shown on them too; whether the version moved as far as the changes need;
 * whether every installed dependent's range admits the new version; and
 * whether the installed set with `next` in place still installs.
 */
export async function checkUpgrade(installed: readonly PackArchive[], next: PackArchive): Promise<UpgradeReport> {
  const current = installed.find((p) => p.name === next.name);
  const diagnostics: PackDiagnostic[] = [];
  if (!current) {
    return {
      pack: next.name,
      from: "",
      to: next.version,
      changes: [],
      needs: "none",
      made: "none",
      diagnostics: [{ code: "missing-dependency", pack: next.name, message: "Not installed, so there is nothing to upgrade; install it instead" }]
    };
  }
  const after = installed.map((p) => (p.name === next.name ? next : p));

  for (const dep of installed) {
    const range = dep.requires[next.name];
    if (range !== undefined && !semver.satisfies(next.version, range))
      diagnostics.push({ code: "dependent-broken", pack: next.name, subject: dep.name, message: `${dep.name} requires ${next.name} ${range}; ${next.version} is outside it` });
  }
  const plan = await planInstall(after, { bindings: stubBindings(after) });
  diagnostics.push(...plan.diagnostics.filter((d) => d.code !== "version-conflict" || d.subject !== next.name));
  diagnostics.push(...weakenedProtections(current, next));

  let changes: ContractChange[] = [];
  let underVersioned: { subject: string; from: string; to: string; needs: "major" | "minor" }[] = [];
  if (plan.diagnostics.length === 0) {
    const beforePlan = await planInstall(installed, { bindings: stubBindings(installed) });
    const diff = diffModels(await describe(installed, beforePlan.order), await describe(after, plan.order));
    changes = diff.changes;
    underVersioned = diff.underVersioned;
  }
  const needs: Bump = changes.some((c) => c.impact === "breaking") ? "major" : changes.length > 0 ? "minor" : "patch";
  const made = bumpOf(current.version, next.version);
  if (RANK[made] < RANK[needs])
    diagnostics.push({
      code: "under-versioned",
      pack: next.name,
      subject: `${current.version} → ${next.version}`,
      message:
        changes.length === 0 && made === "none"
          ? "An upgrade needs a higher version than the installed one"
          : `The changes need a ${needs} version bump; this is ${made === "none" ? "no bump" : `a ${made} bump`}`
    });
  // Only what this pack defines is held to its version: a dependent's Type that inherits a change shows in
  // `changes`, but its author did nothing, and the dependent's range already decides whether it accepts this.
  const owns = (subject: string) => next.contents.types.some((t) => t.name === subject) || next.contents.actions.some((a) => a.name === subject);
  for (const u of underVersioned.filter((x) => owns(x.subject)))
    diagnostics.push({ code: "under-versioned", pack: next.name, subject: u.subject, message: `${u.subject} went from ${u.from} to ${u.to}; its changes need a ${u.needs} bump` });
  return { pack: next.name, from: current.version, to: next.version, changes, needs, made, diagnostics };
}
