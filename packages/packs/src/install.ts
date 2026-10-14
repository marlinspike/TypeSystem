import { randomUUID } from "node:crypto";
import semver from "semver";
import {
  InMemoryRegistryStore,
  SemanticRegistry,
  canonical,
  registerDomain,
  type BindingRegistry,
  type DataSource,
  type DomainManifest,
  type RegisterTypeOptions,
  type TraitDefinition
} from "@typesys/core";
import { revocationsOf, verifyPack, type PackArchive, type VerifyOptions } from "./archive.js";
import { PackError, type PackDiagnostic } from "./diagnostics.js";

export interface InstallOptions {
  /** The code the packs name by binding key: computed values and preconditions (ADR-0015). */
  readonly bindings: BindingRegistry;
  /** When given, every pack must be signed by one of these keys. */
  readonly trustedKeys?: VerifyOptions["trustedKeys"];
  /** Keys no longer trusted: a pack signed by one is refused, and so is any install while an installed pack is (ADR-0069). */
  readonly revokedKeys?: VerifyOptions["revokedKeys"];
  /** Pack builds withdrawn, by digest, refused as revoked keys are. */
  readonly revokedDigests?: VerifyOptions["revokedDigests"];
  /** Who is installing, for the audit row `installPacks` writes. Default `"system"`. */
  readonly actor?: string;
  /** The rule names the deployment's policy engine has. When given, a pack naming another is refused. */
  readonly policies?: readonly string[];
  /** The deployment's adapters. When given, every data source a pack declares needs one. */
  readonly adapters?: readonly { readonly dataSourceId: string }[];
  /**
   * The deployment's own description of a pack's data source, by id: its
   * kind, name or config in this deployment (a pack's in-memory source
   * served by Postgres here). The id, which the pack's mappings and code
   * name, stays.
   */
  readonly dataSources?: Readonly<Record<string, Partial<Omit<DataSource, "id">>>>;
  /** Packs already installed in the target registry: they satisfy requirements and are not registered again. */
  readonly installed?: readonly PackArchive[];
  /**
   * The registry the packs will be installed into (`installPacks` always
   * passes it). Whatever it holds that no installed pack defines may not be
   * redefined, since registering overwrites by name.
   */
  readonly registry?: SemanticRegistry;
}

export interface InstallPlan {
  /** The packs to register, dependencies first. */
  readonly order: readonly PackArchive[];
  /** Everything wrong; empty means the install will succeed. */
  readonly diagnostics: readonly PackDiagnostic[];
}

/** One installed pack, as a deployment records it (a lock file). */
export interface InstalledPack {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

/** The manifest a pack registers as, its code supplied by `bindings`. */
export function manifestOf(archive: PackArchive, bindings: BindingRegistry, dataSources: InstallOptions["dataSources"] = {}): DomainManifest {
  const traits = new Map<string, TraitDefinition>(archive.contents.traits.map((t) => [t.name, t]));
  return {
    domain: archive.name,
    types: archive.contents.types.map((t) => {
      const options: RegisterTypeOptions = {
        name: t.name,
        version: t.version,
        ...(t.extends ? { extends: t.extends } : {}),
        traits: t.traits.map((n) => traits.get(n)!),
        computedImplementations: bindings.computed,
        ...(t.deprecated ? { deprecated: t.deprecated } : {}),
        ...(t.aliases ? { aliases: t.aliases } : {})
      };
      return { schema: structuredClone(t.schema), options };
    }),
    actions: archive.contents.actions.map((a) => ({
      ...structuredClone(a),
      preconditions: a.preconditions.map((p) => ({ description: p.description, bindingId: p.bindingId, check: bindings.preconditions[p.bindingId]! }))
    })),
    dataSources: archive.contents.dataSources.map((d) => ({ ...structuredClone(d), ...dataSources[d.id], id: d.id })),
    mappings: archive.contents.mappings.map((m) => structuredClone(m))
  };
}

/** Packs in an order where each comes after everything it requires; a cycle is reported, not ordered. */
function ordered(packs: readonly PackArchive[], out: PackDiagnostic[]): PackArchive[] {
  const byName = new Map(packs.map((p) => [p.name, p]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const order: PackArchive[] = [];
  const visit = (p: PackArchive, path: string[]) => {
    if (done.has(p.name)) return;
    if (visiting.has(p.name)) {
      out.push({ code: "cycle", pack: p.name, message: `Packs require each other: ${[...path, p.name].join(" → ")}` });
      return;
    }
    visiting.add(p.name);
    for (const dep of Object.keys(p.requires)) {
      const d = byName.get(dep);
      if (d) visit(d, [...path, p.name]);
    }
    visiting.delete(p.name);
    done.add(p.name);
    order.push(p);
  };
  for (const p of packs) visit(p, []);
  return order;
}

/** The pack and everything it requires, transitively. */
function closure(pack: PackArchive, byName: ReadonlyMap<string, PackArchive>): PackArchive[] {
  const seen = new Map<string, PackArchive>();
  const walk = (p: PackArchive) => {
    if (seen.has(p.name)) return;
    seen.set(p.name, p);
    for (const dep of Object.keys(p.requires)) {
      const d = byName.get(dep);
      if (d) walk(d);
    }
  };
  walk(pack);
  return [...seen.values()];
}

function conflicts(all: readonly PackArchive[], out: PackDiagnostic[]): void {
  const kinds: [string, (p: PackArchive) => readonly { readonly name?: string; readonly id?: string }[], (x: { name?: string; id?: string }) => string][] = [
    ["Type", (p) => p.contents.types, (x) => x.name!],
    ["Action", (p) => p.contents.actions, (x) => x.name!],
    ["data source", (p) => p.contents.dataSources, (x) => x.id!],
    ["mapping", (p) => p.contents.mappings, (x) => x.id!],
    ["trait", (p) => p.contents.traits, (x) => x.name!]
  ];
  for (const [kind, items, key] of kinds) {
    const owner = new Map<string, { pack: string; value: string }>();
    for (const p of all)
      for (const item of items(p)) {
        const k = key(item);
        const value = canonical(item);
        const seen = owner.get(k);
        // A trait or data source declared identically by two packs is the same thing; anything else defined twice is a conflict.
        const shareable = kind === "trait" || kind === "data source";
        // Within one pack, only an identical repeat is harmless: otherwise the last definition would silently win.
        if (seen && (seen.pack === p.name ? seen.value !== value : !(shareable && seen.value === value)))
          out.push({ code: "conflict", pack: p.name, subject: k, message: seen.pack === p.name ? `${kind} ${k} is defined twice, differently` : `${kind} ${k} is also defined by ${seen.pack}` });
        else if (!seen) owner.set(k, { pack: p.name, value });
      }
  }
}

/**
 * A Type is named `<domain>.<Name>`. A pack defines Types only in its own
 * domain: its name, or the domain its name starts with (`site-f16` may
 * define `site.F16`). Otherwise any pack could ship `airforce.Aircraft`.
 */
function foreignNamespaces(p: PackArchive, out: PackDiagnostic[]): void {
  for (const t of p.contents.types) {
    const domain = t.name.split(".")[0]!;
    if (p.name !== domain && !p.name.startsWith(`${domain}-`) && !p.name.startsWith(`${domain}.`))
      out.push({ code: "foreign-namespace", pack: p.name, subject: t.name, message: `Defines Type ${t.name}, in the ${domain} domain, which pack ${p.name} does not own` });
  }
}

const withoutId = (schema: object): object => {
  const { $id: _id, ...rest } = schema as { $id?: unknown };
  return rest;
};

/**
 * What the target registry already holds that no installed pack defines:
 * registering would overwrite it by name (ADR-0059, amended). A data source
 * or mapping declared exactly as registered is the same thing and allowed.
 */
async function alreadyRegistered(
  registry: SemanticRegistry,
  archives: readonly PackArchive[],
  installed: readonly PackArchive[],
  dataSources: NonNullable<InstallOptions["dataSources"]>,
  out: PackDiagnostic[]
): Promise<void> {
  const owned = {
    types: new Set(installed.flatMap((p) => p.contents.types.map((t) => t.name))),
    actions: new Set(installed.flatMap((p) => p.contents.actions.map((a) => a.name))),
    dataSources: new Set(installed.flatMap((p) => p.contents.dataSources.map((d) => d.id))),
    mappings: new Set(installed.flatMap((p) => p.contents.mappings.map((m) => m.id))),
    traits: new Set(installed.flatMap((p) => p.contents.traits.map((t) => t.name)))
  };
  const clash = (pack: string, kind: string, subject: string) =>
    out.push({ code: "conflict", pack, subject, message: `${kind} ${subject} is already in the target registry, and no installed pack defines it` });
  for (const a of archives) {
    for (const t of a.contents.types) if (!owned.types.has(t.name) && (await registry.getType(t.name))) clash(a.name, "Type", t.name);
    for (const x of a.contents.actions) if (!owned.actions.has(x.name) && (await registry.getAction(x.name))) clash(a.name, "Action", x.name);
    for (const d of a.contents.dataSources) {
      if (owned.dataSources.has(d.id)) continue;
      const existing = await registry.getDataSource(d.id);
      if (existing && canonical(existing) !== canonical({ ...d, ...dataSources[d.id], id: d.id })) clash(a.name, "data source", d.id);
    }
    for (const m of a.contents.mappings) {
      if (owned.mappings.has(m.id)) continue;
      const existing = (await registry.listMappings(m.typeName)).find((x) => x.id === m.id);
      if (existing && canonical(existing) !== canonical(m)) clash(a.name, "mapping", m.id);
    }
    for (const t of a.contents.traits) {
      if (owned.traits.has(t.name)) continue;
      const existing = registry.getTraitSchema(t.name);
      if (existing && canonical(withoutId(existing)) !== canonical(withoutId(t.schema))) clash(a.name, "trait", t.name);
    }
  }
}

/**
 * Everything that would stop `archives` installing, found before anything
 * is registered (ADR-0059): integrity and signatures, dependencies and
 * their versions, conflicts (within a pack, between packs, and with what
 * the target registry already holds), Types outside a pack's own domain,
 * references nothing provides, missing code, policy rules and adapters, and
 * finally a registration of every pack into a scratch registry, which
 * catches whatever the registry itself refuses. With no overwrite of the
 * target registry allowed, the scratch registry holds everything the
 * install touches, so it validates what the real registry would become.
 */
export async function planInstall(archives: readonly PackArchive[], opts: InstallOptions): Promise<InstallPlan> {
  const out: PackDiagnostic[] = [];
  const installed = opts.installed ?? [];
  const trust: VerifyOptions = {
    ...(opts.trustedKeys ? { trustedKeys: opts.trustedKeys } : {}),
    ...(opts.revokedKeys ? { revokedKeys: opts.revokedKeys } : {}),
    ...(opts.revokedDigests ? { revokedDigests: opts.revokedDigests } : {})
  };
  for (const a of archives) out.push(...verifyPack(a, trust));
  // What is already installed was trusted when it was installed; a revocation since then still applies to it.
  for (const a of installed) out.push(...revocationsOf(a, trust));
  if (out.length > 0) return { order: [], diagnostics: out };

  const names = new Set<string>();
  for (const a of [...installed, ...archives]) {
    if (names.has(a.name)) out.push({ code: "conflict", pack: a.name, message: "The same pack is installed or given twice; an upgrade replaces it (checkUpgrade)" });
    names.add(a.name);
  }
  const all = [...installed, ...archives];
  const byName = new Map(all.map((p) => [p.name, p]));

  for (const a of archives)
    for (const [dep, range] of Object.entries(a.requires)) {
      const d = byName.get(dep);
      if (!d) out.push({ code: "missing-dependency", pack: a.name, subject: dep, message: `Requires ${dep} ${range}, which is neither installed nor given` });
      else if (!semver.satisfies(d.version, range)) out.push({ code: "version-conflict", pack: a.name, subject: dep, message: `Requires ${dep} ${range}; ${d.version} is present` });
    }
  const order = ordered(archives, out);
  conflicts(all, out);
  for (const a of archives) foreignNamespaces(a, out);
  if (opts.registry) await alreadyRegistered(opts.registry, archives, installed, opts.dataSources ?? {}, out);

  for (const a of archives) {
    const reachable = closure(a, byName);
    const provides = {
      types: new Set(reachable.flatMap((p) => p.contents.types.map((t) => t.name))),
      actions: new Set(reachable.flatMap((p) => p.contents.actions.map((x) => x.name))),
      dataSources: new Set(reachable.flatMap((p) => p.contents.dataSources.map((d) => d.id)))
    };
    for (const t of a.requirements.types)
      if (!provides.types.has(t)) out.push({ code: "unresolved-reference", pack: a.name, subject: t, message: `Names Type ${t}, which no pack it requires provides` });
    for (const x of a.requirements.actions)
      if (!provides.actions.has(x)) out.push({ code: "unresolved-reference", pack: a.name, subject: x, message: `Names Action ${x}, which no pack it requires provides` });
    for (const d of a.requirements.dataSources)
      if (!provides.dataSources.has(d)) out.push({ code: "unresolved-reference", pack: a.name, subject: d, message: `Uses data source ${d}, which no pack it requires declares` });
    for (const b of a.requirements.computed)
      if (!Object.hasOwn(opts.bindings.computed, b)) out.push({ code: "missing-binding", pack: a.name, subject: b, message: `No computed implementation supplied for binding "${b}"` });
    for (const b of a.requirements.preconditions)
      if (!Object.hasOwn(opts.bindings.preconditions, b)) out.push({ code: "missing-binding", pack: a.name, subject: b, message: `No precondition implementation supplied for binding "${b}"` });
    if (opts.policies) {
      const known = new Set(opts.policies);
      for (const p of a.requirements.policies) if (!known.has(p)) out.push({ code: "unknown-policy", pack: a.name, subject: p, message: `The policy engine has no rule "${p}"; every request it governs would be refused` });
    }
    if (opts.adapters) {
      const served = new Set(opts.adapters.map((x) => x.dataSourceId));
      for (const d of a.contents.dataSources) if (!served.has(d.id)) out.push({ code: "missing-adapter", pack: a.name, subject: d.id, message: `No adapter serves data source ${d.id}` });
    }
  }
  if (out.length > 0) return { order, diagnostics: out };

  // The registry's own checks (schemas compile, bases exist, mappings resolve), against a scratch registry.
  const scratch = new SemanticRegistry(new InMemoryRegistryStore());
  for (const p of [...ordered(installed, []), ...order]) {
    try {
      await registerDomain(scratch, manifestOf(p, opts.bindings, opts.dataSources));
    } catch (err) {
      out.push({ code: "registration-failed", pack: p.name, message: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
  return { order, diagnostics: out };
}

/**
 * Installs packs into `registry`, dependencies first, after `planInstall`
 * finds nothing wrong; otherwise throws a `PackError` listing every problem
 * and registers nothing. Returns what to record as installed.
 */
export async function installPacks(registry: SemanticRegistry, archives: readonly PackArchive[], opts: InstallOptions): Promise<InstalledPack[]> {
  const plan = await planInstall(archives, { ...opts, registry });
  // Every attempt is audited, refused or not (ADR-0069): what was offered, by digest and signer, and why it was refused.
  const offered = archives.map((a) => ({ name: a.name, version: a.version, digest: a.digest, signedBy: (a.signatures ?? []).map((s) => s.keyId) }));
  const audit = (decision: "allow" | "deny", details: Record<string, unknown>, reason?: string) =>
    registry.appendAuditEvent({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      subjectId: opts.actor ?? "system",
      action: "pack.install",
      resource: { typeName: "*" },
      decision,
      ...(reason ? { reason } : {}),
      details: { packs: offered, signed: opts.trustedKeys !== undefined, ...details }
    });
  if (plan.diagnostics.length > 0) {
    await audit("deny", { diagnostics: plan.diagnostics.map((d) => ({ code: d.code, pack: d.pack, ...(d.subject ? { subject: d.subject } : {}) })) }, [...new Set(plan.diagnostics.map((d) => d.code))].join(", "));
    throw new PackError(plan.diagnostics);
  }
  for (const p of plan.order) await registerDomain(registry, manifestOf(p, opts.bindings, opts.dataSources));
  await audit("allow", { order: plan.order.map((p) => p.name) });
  return [...(opts.installed ?? []), ...plan.order].map((p) => ({ name: p.name, version: p.version, digest: p.digest }));
}
