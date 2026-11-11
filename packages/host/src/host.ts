import { readFileSync } from "node:fs";
import {
  AbacPolicyEngine,
  DEMO_LINEAR_CLASSIFICATION,
  DENY_MARKED_DATA,
  InMemoryRegistryStore,
  SemanticRegistry,
  SemanticRuntime,
  compilePolicies,
  contractMismatches,
  linearClassification,
  mergeBindingRegistries,
  registerDomain,
  type Adapter,
  type BindingRegistry,
  type BuiltRuntime,
  type ClassificationScheme,
  type DomainManifest,
  type Identity,
  type IdentityResolver,
  type PolicyRule,
  type RegistryStore,
  type SemanticRuntimeOptions,
  HIGH_ASSURANCE_V1,
  HIGH_ASSURANCE_V2,
  AdapterUnavailableError,
  composedProperties,
  withAuditLog
} from "@typesys/core";
import { didYouMean } from "@typesys/devkit";
import { PostgresTableAdapter } from "@typesys/adapter-postgres";
import { openState, type HostState } from "./state.js";
import { HttpAdapter, type HttpAdapterConfig, type HttpAuth } from "@typesys/adapter-http";
import { createOidcIdentityResolver } from "@typesys/auth-oidc";
import type { SignIn } from "@typesys/http";
import { installPacks, type InstalledPack, type PackArchive } from "@typesys/packs";
import {
  DeploymentError,
  buildIdOf,
  parseDeployment,
  type ConfigString,
  type Credential,
  type Deployment,
  type HttpAuthSpec,
  type HttpSourceSpec,
  type HttpTypeSpec,
  type PostgresTypeSpec,
  type PostgresSourceSpec
} from "./deployment.js";

/** Where references are resolved: configuration from the environment, credentials from a secret store. */
export interface HostEnvironment {
  env(name: string): string | undefined;
  secret(name: string): string | undefined;
  /** How the identity provider's discovery document and keys are fetched (ADR-0116). Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * A secret from `vars[name]`, or else from the file `vars[name_FILE]` names
 * (ADR-0119): the convention Docker and Kubernetes secrets mounted as files
 * use, so a multi-line key need never be put in an environment variable.
 * One trailing newline is dropped, as a file written by an editor has one.
 */
export function secretFromEnvironment(vars: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const direct = vars[name];
  if (direct !== undefined && direct !== "") return direct;
  const file = vars[`${name}_FILE`];
  if (!file) return direct;
  try {
    return readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } catch (err) {
    throw new DeploymentError([`secret ${name}: ${name}_FILE names ${file}, which cannot be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`]);
  }
}

/** Both from `process.env`: what a container gets from its ConfigMap and Secret. A secret may also be a file `<NAME>_FILE` names. */
export const processEnvironment: HostEnvironment = {
  env: (name) => process.env[name],
  secret: (name) => secretFromEnvironment(process.env, name)
};

/** Nothing set: every reference falls back to its default, or fails. */
export const emptyEnvironment: HostEnvironment = { env: () => undefined, secret: () => undefined };

/** An environment from fixed values, falling back to another: how a test or an in-process host points at its own services. */
export function overlayEnvironment(values: Readonly<Record<string, string | undefined>>, base: HostEnvironment = processEnvironment): HostEnvironment {
  const own = (name: string) => (Object.hasOwn(values, name) ? values[name] : undefined);
  return { env: (name) => own(name) ?? base.env(name), secret: (name) => own(name) ?? base.secret(name) };
}

export interface HostExtensionContext {
  readonly deployment: Deployment;
  readonly env: HostEnvironment;
  /** The adapters the deployment configures itself (its `http` sources), by data source id. */
  readonly sources: Readonly<Record<string, Adapter>>;
}

/**
 * Code a deployment needs, named in its `extensions` (ADR-0102): bindings
 * for the computed values and preconditions its packs name, adapters for its
 * `extension` sources, decorators of its other sources, and an identity
 * resolver. An extension adds no policy, Type or source the deployment does
 * not declare: what it returns is checked against the deployment.
 */
export interface HostExtension {
  readonly name: string;
  readonly bindings?: BindingRegistry;
  /** Adapters, each for a source the deployment declares: one of this extension's, or a decorator of another (same id). */
  readonly adapters?: (ctx: HostExtensionContext) => readonly Adapter[] | Promise<readonly Adapter[]>;
  readonly identityResolver?: IdentityResolver;
  /** Releases what the extension started (services, connections) when the host closes. */
  readonly close?: () => Promise<void>;
}

export interface HostOptions {
  /** The pack archives the deployment lists, by name and version (and digest, where it gives one). */
  readonly packs: readonly PackArchive[];
  readonly extensions?: readonly HostExtension[];
  readonly env?: HostEnvironment;
  /**
   * Default: a registry in this process, built from the packs (ADR-0102). Nothing another replica writes can change it.
   * Its audit rows go to the deployment's audit trail (`state.audit`, ADR-0106) whatever store is given.
   */
  readonly store?: RegistryStore;
  /** Code-only runtime options (a shared cache, a rate limiter, query limits); they override the deployment's own. */
  readonly runtimeOptions?: SemanticRuntimeOptions;
  /**
   * Model and rules given as code beside the deployment's packs and policies,
   * for a host extended in-process by an application (the cold chain's
   * `extend`). Recorded under `code` so nothing about them is hidden; a rule
   * here may not reuse a deployment policy's name.
   */
  readonly manifests?: readonly DomainManifest[];
  readonly policyRules?: Readonly<Record<string, PolicyRule>>;
  /**
   * `declared` (the default) opens the state the deployment declares (ADR-0106). `memory` keeps everything in
   * this process whatever it declares: what the upgrade check and `typesys deploy build` use, so they write
   * nothing into a deployment's audit trail or journal.
   */
  readonly state?: "declared" | "memory";
  /** Who installs the packs, for the `pack.install` audit row. Default `"host"`. */
  readonly actor?: string;
}

export interface Host extends BuiltRuntime {
  readonly deployment: Deployment;
  /** The build id every audit row of this host names (ADR-0101). */
  readonly build: string;
  readonly identityResolver: IdentityResolver;
  /** How callers sign in, for a deployment whose identity is OpenID Connect (ADR-0116): served by every transport. */
  readonly signIn?: SignIn;
  /** The deployment's personas, `anonymous` always among them. */
  readonly personas: Readonly<Record<string, Identity>>;
  readonly packs: readonly InstalledPack[];
  /** Every adapter the runtime has, by data source id. */
  readonly adapters: Readonly<Record<string, Adapter>>;
  /** What the deployment's `state` opened (ADR-0106): the audit trail, the workflow journal, the cache and rate limiter. */
  readonly state: HostState;
  /**
   * Checks every declared `postgres` source against its database's catalog
   * (ADR-0110): each mapped table or view exists and may be read, and has
   * the id and property columns the mapping names. Reads no rows. Resolves
   * with every problem found, each naming the source, the Type and the
   * column; rejects with `AdapterUnavailableError` when a database cannot
   * be reached, which says nothing about the mapping.
   */
  checkSources(): Promise<string[]>;
  /** What this host runs that the deployment does not hold as data. */
  readonly code: {
    readonly extensions: readonly string[];
    /** Sources an extension supplies or decorates, with the extension's name. */
    readonly sources: Readonly<Record<string, string>>;
    readonly manifests: readonly string[];
    readonly policies: readonly string[];
  };
  close(): Promise<void>;
}

const ANONYMOUS: Identity = Object.freeze({ subjectId: "anonymous", roles: [], attributes: {} });

/** Closes every extension, whatever one of them throws. */
async function closeAll(extensions: Iterable<HostExtension>): Promise<void> {
  await Promise.allSettled([...extensions].map(async (e) => e.close?.()));
}

/** A `ConfigString` from the environment, as the host resolves every one: a set variable, else its default, else an error naming it. */
export function resolveConfig(value: ConfigString, env: HostEnvironment, at: string): string {
  if (typeof value === "string") return value;
  const raw = env.env(value.$env) ?? value.default;
  if (raw === undefined || raw === "") throw new DeploymentError([`${at}: environment variable ${value.$env} is not set`]);
  return value.path ? new URL(value.path, raw).href : raw;
}

function resolveCredential(value: Credential, env: HostEnvironment, demo: boolean, at: string): string {
  if (typeof value === "string") return value;
  const secret = env.secret(value.$secret) ?? (demo ? value.default : undefined);
  if (secret === undefined || secret === "") throw new DeploymentError([`${at}: secret ${value.$secret} is not set`]);
  return `${value.prefix ?? ""}${secret}`;
}

function httpAuth(spec: HttpAuthSpec, env: HostEnvironment, demo: boolean, at: string): HttpAuth {
  if (spec.kind === "header") return { kind: "header", name: spec.name, value: resolveCredential(spec.value, env, demo, `${at}.value`) };
  if (spec.kind === "basic")
    return { kind: "header", name: "authorization", value: `Basic ${Buffer.from(`${spec.username}:${resolveCredential(spec.password, env, demo, `${at}.password`)}`).toString("base64")}` };
  return {
    kind: "client-credentials",
    tokenUrl: resolveConfig(spec.tokenUrl, env, `${at}.tokenUrl`),
    clientId: spec.clientId,
    clientSecret: resolveCredential(spec.clientSecret, env, demo, `${at}.clientSecret`),
    ...(spec.scope !== undefined ? { scope: spec.scope } : {})
  };
}

/**
 * The adapter a deployment's `http` source describes, its references
 * resolved from `env`. A `$secret` default is used only when `demo` is true.
 */
export function adapterForSource(id: string, spec: HttpSourceSpec, env: HostEnvironment, demo: boolean): HttpAdapter {
  const at = `sources["${id}"]`;
  const config: HttpAdapterConfig = {
    dataSourceId: id,
    system: spec.system,
    baseUrl: resolveConfig(spec.baseUrl, env, `${at}.baseUrl`),
    ...(spec.auth ? { auth: httpAuth(spec.auth, env, demo, `${at}.auth`) } : {}),
    types: spec.types,
    ...(spec.actions ? { actions: spec.actions } : {}),
    ...(spec.maxPages !== undefined ? { maxPages: spec.maxPages } : {})
  };
  return new HttpAdapter(config);
}

function classificationOf(deployment: Deployment): ClassificationScheme {
  const c = deployment.classification ?? { kind: "deny-marked" };
  if (c.kind === "linear") return linearClassification(c.levels, c.name);
  if (c.kind === "demo-linear") return DEMO_LINEAR_CLASSIFICATION;
  return DENY_MARKED_DATA;
}

function identityResolverOf(
  deployment: Deployment,
  env: HostEnvironment,
  personas: Readonly<Record<string, Identity>>,
  extensions: ReadonlyMap<string, HostExtension>
): { resolver: IdentityResolver; signIn?: SignIn } {
  const spec = deployment.identity;
  if (spec.kind === "oidc") {
    const issuer = resolveConfig(spec.issuer, env, "identity.issuer");
    const audience = spec.audience !== undefined ? resolveConfig(spec.audience, env, "identity.audience") : undefined;
    const jwksUrl = spec.jwksUrl !== undefined ? resolveConfig(spec.jwksUrl, env, "identity.jwksUrl") : undefined;
    const resource = spec.resource !== undefined ? resolveConfig(spec.resource, env, "identity.resource").replace(/\/+$/, "") : undefined;
    if (resource !== undefined && !/^https?:\/\/[^/?#]+$/.test(resource)) throw new DeploymentError([`identity.resource: ${resource} is not an origin such as https://typesys.example.com`]);
    const resolver = createOidcIdentityResolver({
      issuer,
      ...(audience ? { audience } : {}),
      ...(spec.rolesClaim ? { rolesClaim: spec.rolesClaim } : {}),
      ...(spec.roleMap ? { roleMap: spec.roleMap } : {}),
      ...(spec.clearanceClaim ? { clearanceClaim: spec.clearanceClaim } : {}),
      ...(jwksUrl ? { jwksUrl } : {}),
      ...(env.fetch ? { fetch: env.fetch } : {}),
      // A bad token is refused (401) and a provider that cannot be reached is a 503, never quietly anonymous (ADR-0116).
      failOpenToAnonymous: false
    });
    return {
      resolver,
      signIn: {
        issuer,
        resourceName: deployment.name,
        requireToken: spec.allowAnonymous !== true,
        ...(resource ? { resource } : {}),
        ...(spec.scopes?.length ? { scopes: spec.scopes } : {})
      }
    };
  }
  if (spec.kind === "tokens") {
    const tokens = spec.tokens;
    // Own properties only: "constructor" and "__proto__" are not tokens.
    return { resolver: (token) => Promise.resolve(token && Object.hasOwn(tokens, token) ? personas[tokens[token]!]! : personas.anonymous!) };
  }
  const resolver = extensions.get(spec.extension)?.identityResolver;
  if (!resolver) throw new DeploymentError([`identity: extension "${spec.extension}" supplies no identity resolver`]);
  return { resolver };
}

/** The read-only table adapter a deployment's `postgres` source describes (ADR-0107), over the host's pool for its URL. */
export function postgresAdapterForSource(id: string, spec: PostgresSourceSpec, pool: HostState["pool"], url: string): PostgresTableAdapter {
  try {
    return new PostgresTableAdapter(pool(url), { dataSourceId: id, system: spec.system, types: spec.types, ...(spec.maxRows !== undefined ? { maxRows: spec.maxRows } : {}) });
  } catch (err) {
    throw new DeploymentError([`sources["${id}"]: ${(err as Error).message}`]);
  }
}

/**
 * What a deployment's own sources map that the model does not have
 * (ADR-0110): a Type no pack registers, a Type whose mapping in the model
 * reads another source, and a property the Type does not have. Each comes
 * with the name probably meant, when one is close.
 */
async function sourceMappingProblems(deployment: Deployment, registry: SemanticRegistry): Promise<string[]> {
  const problems: string[] = [];
  const types = await registry.listTypes();
  const names = types.map((t) => t.name);
  for (const [id, spec] of Object.entries(deployment.sources)) {
    if (spec.kind === "extension") continue;
    const specs = Object.entries(spec.types as Readonly<Record<string, HttpTypeSpec | PostgresTypeSpec>>);
    for (const [typeName, m] of specs) {
      const at = `sources["${id}"].types["${typeName}"]`;
      const type = types.find((t) => t.name === typeName);
      if (!type) {
        const near = didYouMean(typeName, names);
        problems.push(`${at}: no pack has a Type ${typeName}${near ? ` (did you mean ${near}?)` : ""}`);
        continue;
      }
      const readers = new Set((await registry.listMappings(typeName)).map((x) => x.dataSourceId));
      if (readers.size > 0 && !readers.has(id)) problems.push(`${at}: the model reads ${typeName} from ${[...readers].sort().join(", ")}, not from "${id}"`);
      const { properties } = await composedProperties(registry, type);
      const known = Object.keys(properties);
      const mapped = "columns" in m ? Object.keys(m.columns) : Object.keys(m.fields);
      for (const property of mapped) {
        if (Object.hasOwn(properties, property)) continue;
        const near = didYouMean(property, known);
        problems.push(`${at}: ${typeName} has no property "${property}"${near ? ` (did you mean "${near}"?)` : ""}`);
      }
    }
  }
  return problems;
}

/**
 * Builds one governed runtime from a deployment (ADR-0102). Everything is
 * checked before anything is built, and every problem is reported at once:
 * the packs offered are exactly the ones listed, every extension named is
 * supplied, every source the model reads is declared and served, every
 * adapter an extension returns is for a declared source, and nothing a pack
 * names is missing (`installPacks` plans before it registers). The registry
 * is this process's own, filled from the packs, so a replica booting a new
 * build never changes what another replica serves.
 */
export async function buildHost(deploymentDoc: Deployment, options: HostOptions): Promise<Host> {
  const deployment = parseDeployment(deploymentDoc);
  const env = options.env ?? processEnvironment;
  const demo = deployment.demo === true;
  const problems: string[] = [];

  // Extensions: exactly the ones the deployment names.
  const extensions = new Map<string, HostExtension>();
  for (const e of options.extensions ?? []) {
    if (extensions.has(e.name)) problems.push(`extension "${e.name}" is supplied twice`);
    extensions.set(e.name, e);
  }
  const named = new Set(deployment.extensions ?? []);
  for (const n of named) if (!extensions.has(n)) problems.push(`extension "${n}" is named by the deployment but not supplied`);
  for (const n of extensions.keys()) if (!named.has(n)) problems.push(`extension "${n}" is supplied but the deployment does not name it`);

  // Packs: exactly the ones the deployment lists, at the version (and digest) it lists.
  const archives: PackArchive[] = [];
  const byName = new Map<string, PackArchive>();
  for (const a of options.packs) {
    if (byName.has(a.name)) problems.push(`pack ${a.name} is supplied twice`);
    byName.set(a.name, a);
  }
  for (const ref of deployment.packs) {
    const a = byName.get(ref.name);
    if (!a) problems.push(`pack ${ref.name}@${ref.version} is listed but not supplied`);
    else if (a.version !== ref.version) problems.push(`pack ${ref.name}: the deployment lists ${ref.version}, ${a.version} was supplied`);
    else if (ref.digest && ref.digest.toLowerCase() !== a.digest.toLowerCase()) problems.push(`pack ${ref.name}@${ref.version}: digest ${a.digest} is not the ${ref.digest} the deployment lists`);
    else archives.push(a);
  }
  for (const name of byName.keys()) if (!deployment.packs.some((p) => p.name === name)) problems.push(`pack ${name} is supplied but the deployment does not list it`);

  // Policies: the deployment's, as data; code rules may not shadow one.
  let rules: Record<string, PolicyRule> = {};
  try {
    rules = compilePolicies(deployment.policies);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  for (const name of Object.keys(options.policyRules ?? {})) if (Object.hasOwn(rules, name)) problems.push(`code policy "${name}" would replace the deployment's rule of that name`);

  // Every source a model declares must be declared here, and every source declared here must be one a model declares.
  // From every pack listed by name, even one refused above for its version or digest: its sources are still the ones meant, so they are not reported again.
  const listed = deployment.packs.map((p) => byName.get(p.name)).filter((a): a is PackArchive => a !== undefined);
  const modelSources = new Set<string>([
    ...listed.flatMap((a) => (a.contents?.dataSources ?? []).map((d) => d.id)),
    ...(options.manifests ?? []).flatMap((m) => (m.dataSources ?? []).map((d) => d.id))
  ]);
  for (const id of Object.keys(deployment.sources)) if (!modelSources.has(id)) problems.push(`sources["${id}"]: no pack declares a data source with this id`);
  if (problems.length > 0) throw new DeploymentError(problems);

  // State: the audit trail, workflow journal, cache and rate limiter the deployment declares (ADR-0106), reachable before anything is served.
  const resolve = (value: Credential, at: string) => resolveCredential(value, env, demo, at);
  const state = await openState(options.state === "memory" ? { ...deployment, state: {} } : deployment, resolve);
  // Whatever fails from here on, nothing the state opened (pools, Redis clients, the checkpoint timer) is left open.
  let started = false;
  try {

  // Adapters: the deployment's own, then each extension's, checked against what the deployment declares.
  const own: Record<string, Adapter> = {};
  for (const [id, spec] of Object.entries(deployment.sources)) {
    try {
      if (spec.kind === "http") own[id] = adapterForSource(id, spec, env, demo);
      else if (spec.kind === "postgres") own[id] = postgresAdapterForSource(id, spec, state.pool, resolve(spec.url, `sources["${id}"].url`));
    } catch (err) {
      problems.push(...(err instanceof DeploymentError ? err.problems : [String(err)]));
    }
  }
  if (problems.length > 0) throw new DeploymentError(problems);
  const adapters = new Map<string, Adapter>(Object.entries(own));
  const supplied: Record<string, string> = {};
  for (const [name, ext] of extensions) {
    const returned = (await ext.adapters?.({ deployment, env, sources: { ...own } })) ?? [];
    for (const a of returned) {
      const spec = Object.hasOwn(deployment.sources, a.dataSourceId) ? deployment.sources[a.dataSourceId] : undefined;
      if (!spec) problems.push(`extension "${name}" returned an adapter for "${a.dataSourceId}", which the deployment does not declare`);
      else if (spec.kind === "extension" && spec.extension !== name) problems.push(`extension "${name}" returned an adapter for "${a.dataSourceId}", which the deployment gives to "${spec.extension}"`);
      else if (Object.hasOwn(supplied, a.dataSourceId)) problems.push(`"${a.dataSourceId}" is supplied by both "${supplied[a.dataSourceId]}" and "${name}"`);
      else {
        supplied[a.dataSourceId] = name;
        adapters.set(a.dataSourceId, a);
      }
    }
  }
  for (const [id, spec] of Object.entries(deployment.sources)) if (spec.kind === "extension" && !adapters.has(id)) problems.push(`sources["${id}"]: extension "${spec.extension}" supplied no adapter for it`);

  const personas: Record<string, Identity> = { anonymous: ANONYMOUS, ...(deployment.personas ?? {}) };
  let identityResolver: IdentityResolver | undefined;
  let signIn: SignIn | undefined;
  try {
    ({ resolver: identityResolver, signIn } = identityResolverOf(deployment, env, personas, extensions));
  } catch (err) {
    problems.push(...(err instanceof DeploymentError ? err.problems : [String(err)]));
  }
  if (problems.length > 0) throw new DeploymentError(problems);

  const build = buildIdOf(deployment, archives.map((a) => a.digest));
  const registry = new SemanticRegistry(withAuditLog(options.store ?? new InMemoryRegistryStore(), state.audit), undefined, { build });
  const allRules = { ...rules, ...options.policyRules };
  const bindings = mergeBindingRegistries(...[...extensions.values()].map((e) => e.bindings ?? { computed: {}, preconditions: {} }));
  let installed: InstalledPack[];
  {
    installed = await installPacks(registry, archives, {
      bindings,
      actor: options.actor ?? "host",
      policies: Object.keys(allRules),
      adapters: [...adapters.values()],
      ...(deployment.trust?.keys ? { trustedKeys: deployment.trust.keys } : {}),
      ...(deployment.trust?.revokedKeys ? { revokedKeys: deployment.trust.revokedKeys } : {}),
      ...(deployment.trust?.revokedDigests ? { revokedDigests: deployment.trust.revokedDigests } : {})
    });
    for (const m of options.manifests ?? []) await registerDomain(registry, m);
    // Every consumer the deployment declares must be served at versions its contract accepts (ADR-0103): a build that breaks one does not start.
    const served = new Map((await registry.listTypes()).map((t) => [t.name, t.version]));
    const broken = (deployment.consumers ?? []).flatMap((c) =>
      contractMismatches(c.contract, served).map((m) => `consumers: ${c.name} needs ${m.type} ${m.range}, ${m.version ? `this build has ${m.version}` : "this build has no such Type"}`)
    );
    if (broken.length > 0) throw new DeploymentError(broken);
    // Every Type and property a declared source maps must be one the model has (ADR-0110): a misspelt one would otherwise be silently never read.
    const mappingProblems = await sourceMappingProblems(deployment, registry);
    if (mappingProblems.length > 0) throw new DeploymentError(mappingProblems);
  }

  const policyEngine = new AbacPolicyEngine();
  for (const [name, rule] of Object.entries(allRules)) policyEngine.registerRule(name, rule);
  const runtime = new SemanticRuntime(registry, [...adapters.values()], policyEngine, {
    classification: classificationOf(deployment),
    ...(deployment.runtime?.callTimeoutMs !== undefined ? { resilience: { callTimeoutMs: deployment.runtime.callTimeoutMs } } : {}),
    ...(deployment.runtime?.inspectionPolicy ? { inspection: { policy: deployment.runtime.inspectionPolicy } } : {}),
    ...(deployment.runtime?.securityProfile === "high-assurance-v1" ? { securityProfile: HIGH_ASSURANCE_V1 } : {}),
    ...(deployment.runtime?.securityProfile === "high-assurance-v2" ? { securityProfile: HIGH_ASSURANCE_V2 } : {}),
    ...(deployment.runtime?.discovery ? { discovery: deployment.runtime.discovery } : {}),
    ...(state.cache ? { cache: state.cache } : {}),
    ...(state.cacheTtlMs !== undefined ? { defaultCacheTtlMs: state.cacheTtlMs } : {}),
    ...(state.rateLimiter ? { rateLimiter: state.rateLimiter } : {}),
    // Spans leave the process once a deployment names a collector (ADR-0121): no object or subject id goes with them.
    telemetryIdentity: "none",
    ...options.runtimeOptions
  });

  let closed = false;
  started = true;
  return {
    registry,
    runtime,
    policyEngine,
    deployment,
    build,
    identityResolver: identityResolver!,
    ...(signIn ? { signIn } : {}),
    personas,
    packs: installed,
    adapters: Object.fromEntries(adapters),
    state,
    async checkSources() {
      const problems: string[] = [];
      for (const [id, spec] of Object.entries(deployment.sources)) {
        const adapter = own[id];
        if (spec.kind !== "postgres" || !(adapter instanceof PostgresTableAdapter)) continue;
        try {
          problems.push(...(await adapter.checkMapping()).map((p) => `sources["${id}"]: ${p}`));
        } catch (err) {
          if (err instanceof AdapterUnavailableError) throw new AdapterUnavailableError(`sources["${id}"]: ${err.message}`);
          throw err;
        }
      }
      return problems;
    },
    code: {
      extensions: [...extensions.keys()],
      sources: supplied,
      manifests: (options.manifests ?? []).flatMap((m) => m.types.map((t) => t.options.name)),
      policies: Object.keys(options.policyRules ?? {})
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeAll(extensions.values());
      await registry.close().catch(() => undefined);
      await state.close();
    }
  };
  } finally {
    if (!started) {
      await closeAll(extensions.values());
      await state.close();
    }
  }
}
