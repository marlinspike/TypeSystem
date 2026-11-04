import { createHash } from "node:crypto";
import { canonical, validatePolicyExpression, type Identity, type PolicyDocument } from "@typesys/core";

/**
 * A deployment, declared (ADR-0102): everything that makes one governed
 * TypeSystem runtime, as data. Which packs make the model, which system
 * serves each data source and with which credential reference, the policy
 * rules, the classification scheme, how a bearer token becomes an identity,
 * the personas an upgrade check reads as, and the consumers whose contracts
 * the deployment must keep. One generic host (`buildHost`) builds the
 * runtime from it; a change to it is a new build, checked before it rolls.
 */
export const DEPLOYMENT_FORMAT = "typesys.deployment/1";

/** A configuration value read from the host's environment when the host is built, never stored in the deployment. */
export interface EnvRef {
  readonly $env: string;
  /** A path resolved against the value as a URL (`/oauth/token` against a service's base URL). */
  readonly path?: string;
  /** Used when the variable is unset. */
  readonly default?: string;
}

/** A credential, read from the host's secret resolver (by default the environment) when the host is built. */
export interface SecretRef {
  readonly $secret: string;
  /** Put before the value: `ApiKey ` for a header that carries a scheme. */
  readonly prefix?: string;
  /** A demonstration's well-known value, used when the secret is unset. Refused unless the deployment is a demo. */
  readonly default?: string;
}

/** A string, or a reference resolved when the host is built. */
export type ConfigString = string | EnvRef;
export type Credential = string | SecretRef;

export type HttpFieldSpec = string | { readonly from: string; readonly map: Readonly<Record<string, unknown>> };

/** `@typesys/adapter-http`'s mapping, as data. */
export interface HttpTypeSpec {
  readonly get: string;
  readonly record?: string;
  readonly list: {
    readonly path: string;
    readonly items: string;
    readonly next?: string;
    readonly cursorParam?: string;
    readonly pages?: { readonly param: string; readonly more: string; readonly first?: number };
    readonly pageSizeParam?: string;
    readonly pageSize?: number;
    readonly params?: Readonly<Record<string, string>>;
  };
  readonly id: string;
  readonly fields: Readonly<Record<string, HttpFieldSpec>>;
}

export type HttpAuthSpec =
  | { readonly kind: "header"; readonly name: string; readonly value: Credential }
  | { readonly kind: "basic"; readonly username: string; readonly password: Credential }
  | { readonly kind: "client-credentials"; readonly tokenUrl: ConfigString; readonly clientId: string; readonly clientSecret: Credential; readonly scope?: string };

/** A data source served by `@typesys/adapter-http`, configured entirely here. */
export interface HttpSourceSpec {
  readonly kind: "http";
  readonly system: string;
  readonly baseUrl: ConfigString;
  readonly auth?: HttpAuthSpec;
  readonly types: Readonly<Record<string, HttpTypeSpec>>;
  readonly actions?: Readonly<Record<string, { readonly method: "POST" | "PUT" | "PATCH" | "DELETE"; readonly path: string; readonly body?: readonly string[] }>>;
  readonly maxPages?: number;
}

/** A data source whose adapter is code, supplied by one of the deployment's extensions under this id. */
export interface ExtensionSourceSpec {
  readonly kind: "extension";
  /** The extension that supplies it, by name. */
  readonly extension: string;
  readonly system?: string;
}

/** How one Type maps onto one table or view of a `postgres` source (ADR-0107). */
export interface PostgresTypeSpec {
  /** `schema.table`, or a table on the search path. */
  readonly table: string;
  /** The column holding the object id. */
  readonly id: string;
  /** Property name → column, or a column with a conversion and value map. */
  readonly columns: Readonly<
    Record<string, string | { readonly column: string; readonly as?: "text" | "date" | "date-time" | "number" | "integer" | "boolean" | "json"; readonly map?: Readonly<Record<string, unknown>> }>
  >;
}

/** A data source served by `@typesys/adapter-postgres`'s table adapter, read-only, configured entirely here (ADR-0107). */
export interface PostgresSourceSpec {
  readonly kind: "postgres";
  readonly system: string;
  /** The connection string: it holds a password, so it is a credential. */
  readonly url: Credential;
  readonly types: Readonly<Record<string, PostgresTypeSpec>>;
  /** Most rows one query reads before refusing a partial answer. Default 10,000. */
  readonly maxRows?: number;
}

export type SourceSpec = HttpSourceSpec | PostgresSourceSpec | ExtensionSourceSpec;

/** Where the audit trail is kept (ADR-0105, ADR-0106). */
export type AuditStateSpec =
  /** In this process: lost when it stops. Allowed only in a demo. */
  | { readonly kind: "memory"; readonly signing?: AuditSigningSpec; readonly verifyKeys?: Readonly<Record<string, string>> }
  | {
      readonly kind: "postgres";
      readonly url: Credential;
      /** Signs each chain's head at intervals. Required outside a demo. */
      readonly signing?: AuditSigningSpec;
      /** Key id → Ed25519 public key (PEM): what `typesys audit verify` checks checkpoints with. */
      readonly verifyKeys?: Readonly<Record<string, string>>;
      /** Rows older than this may be pruned by `typesys audit prune`, and only behind a checkpoint. Default: kept forever. */
      readonly retainDays?: number;
    };

export interface AuditSigningSpec {
  readonly keyId: string;
  /** The Ed25519 private key, PEM. */
  readonly key: Credential;
  /** Default 1,000. */
  readonly everyRows?: number;
  /** Default 60. */
  readonly everySeconds?: number;
}

/**
 * Where the deployment keeps what outlives a request (ADR-0106). The model
 * is always built in-process from the packs (ADR-0102); this is everything
 * else: the audit trail, workflow runs and approvals, the cache and the rate
 * budget. Anything left out is kept in the process, and lost with it.
 */
export interface StateSpec {
  readonly audit?: AuditStateSpec;
  /** Workflow runs, steps and approvals (ADR-0066). */
  readonly workflows?: { readonly kind: "memory" } | { readonly kind: "postgres"; readonly url: Credential };
  /** Shared by every replica, so one replica's cached read serves another's (ADR-0025). Marked and encrypted data is never cached in it (ADR-0036). */
  readonly cache?: { readonly kind: "memory" } | { readonly kind: "redis"; readonly url: Credential; readonly keyPrefix?: string; readonly ttlMs?: number };
  /** One budget per subject across replicas when `redis` (ADR-0019, ADR-0025). */
  readonly rateLimit?: { readonly kind: "memory" | "redis"; readonly url?: Credential; readonly capacity: number; readonly refillPerSecond: number; readonly keyPrefix?: string };
}

/** A compiled application the generic server runs on the deployment's one runtime and workflow engine (ADR-0108). */
export interface ApplicationSpec {
  /** The application's name, as its `app.json` gives it. */
  readonly name: string;
  /**
   * An installed package's specifier for its built server module. Default:
   * `<name>/dist/server.js` under `TYPESYS_APPS_DIR`, else an `apps`
   * directory beside the deployment, else this repository's `examples/apps`.
   * Either way the module exports `application`.
   */
  readonly module?: string;
  /** Where its API and pages are served. */
  readonly port: ConfigString;
}

export type ClassificationSpec =
  /** Nobody reads marked data: the runtime's default (ADR-0034). */
  | { readonly kind: "deny-marked" }
  /** A linear ordering of markings, lowest first. */
  | { readonly kind: "linear"; readonly name: string; readonly levels: readonly string[] }
  /** The demonstration ordering (UNCLASSIFIED < CUI < SECRET < TOP SECRET). Refused unless the deployment is a demo. */
  | { readonly kind: "demo-linear" };

export type IdentitySpec =
  /** Bearer tokens verified against an OpenID Connect issuer (`@typesys/auth-oidc`). */
  | {
      readonly kind: "oidc";
      readonly issuer: ConfigString;
      /** The `aud` a token must carry. Required unless the deployment is a demo (ADR-0116): without it, a token the provider issued for any other application is accepted. */
      readonly audience?: ConfigString;
      readonly rolesClaim?: string;
      /** The provider's group or role names → the deployment's roles. When given, only what it lists grants a role (ADR-0116). */
      readonly roleMap?: Readonly<Record<string, readonly string[]>>;
      readonly clearanceClaim?: string;
      /** The provider's key set. Default: `jwks_uri` from its discovery document (ADR-0116). */
      readonly jwksUrl?: ConfigString;
      /**
       * The address clients reach this server by (`https://typesys.example.com`),
       * which MCP clients are told to sign in for (RFC 9728, ADR-0116).
       * Default: the address each request was made to.
       */
      readonly resource?: ConfigString;
      /** Scopes a client asks the provider for, when the provider needs them named. */
      readonly scopes?: readonly string[];
      /** Serve a request with no token as anonymous instead of asking the client to sign in. Default false. */
      readonly allowAnonymous?: boolean;
    }
  /** Fixed tokens naming personas. Constants grant roles, so this is refused unless the deployment is a demo. */
  | { readonly kind: "tokens"; readonly tokens: Readonly<Record<string, string>> }
  /** A resolver one of the deployment's extensions supplies. */
  | { readonly kind: "extension"; readonly extension: string };

/** A pack the model is made of: found by name and version, and, when a digest is given, that exact build. */
export interface PackRef {
  readonly name: string;
  readonly version: string;
  readonly digest?: string;
  /** Where the loader finds it, relative to the deployment file. */
  readonly file?: string;
}

/** An application or agent the deployment serves, and the Type versions it was built against (ADR-0103). */
export interface ConsumerSpec {
  readonly name: string;
  /** Type name → semver range. */
  readonly contract: Readonly<Record<string, string>>;
}

export interface Deployment {
  readonly format: typeof DEPLOYMENT_FORMAT;
  readonly name: string;
  readonly description?: string;
  /**
   * A demonstration: static tokens, the demonstration classification and
   * well-known default credentials are allowed. Never set for real traffic.
   */
  readonly demo?: boolean;
  readonly packs: readonly PackRef[];
  /** Code the deployment needs, by name: bindings, adapters for `extension` sources, an identity resolver. */
  readonly extensions?: readonly string[];
  /** Every system the runtime reads or writes, by data source id. Nothing else is reachable. */
  readonly sources: Readonly<Record<string, SourceSpec>>;
  /** Where the audit trail, workflow runs, cache and rate budget are kept (ADR-0106). */
  readonly state?: StateSpec;
  /** Compiled applications served by this deployment's runtime (ADR-0108). */
  readonly applications?: readonly ApplicationSpec[];
  readonly policies: PolicyDocument;
  readonly classification?: ClassificationSpec;
  readonly identity: IdentitySpec;
  /** Named identities: what demo tokens resolve to, and who an upgrade check reads as (ADR-0104). */
  readonly personas?: Readonly<Record<string, Identity>>;
  readonly runtime?: {
    /** Per adapter call, in milliseconds (ADR-0026). */
    readonly callTimeoutMs?: number;
    /** The policy that decides who may inspect the enforcement structure (ADR-0088). */
    readonly inspectionPolicy?: string;
    /** A security profile the runtime refuses to start without satisfying (ADR-0046). */
    readonly securityProfile?: "high-assurance-v1";
    /**
     * Send the runtime's traces and metrics (ADR-0017) to an OpenTelemetry
     * collector over OTLP/HTTP (ADR-0121). Spans carry no values.
     */
    readonly telemetry?: {
      /** The collector's base URL, such as `http://otel-collector:4318`. */
      readonly otlpEndpoint: ConfigString;
      /** Default `typesys-<deployment name>`. */
      readonly serviceName?: string;
      /** Default 60. */
      readonly metricsIntervalSeconds?: number;
    };
    /** One JSON line per request on standard output, never a value, token or query (ADR-0121). Default true. */
    readonly requestLog?: boolean;
  };
  readonly trust?: {
    /** Key id → public key (PEM). When given, every pack must be signed by one of them. */
    readonly keys?: Readonly<Record<string, string>>;
    readonly revokedKeys?: Readonly<Record<string, { readonly reason?: string; readonly revokedAt?: string }>>;
    readonly revokedDigests?: Readonly<Record<string, { readonly reason?: string; readonly revokedAt?: string }>>;
  };
  readonly consumers?: readonly ConsumerSpec[];
}

/** A deployment that is not well formed, with every problem found. */
export class DeploymentError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid deployment: ${problems.join("; ")}`);
    this.name = "DeploymentError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

function unknownFields(value: Record<string, unknown>, allowed: readonly string[], at: string, out: string[]): void {
  for (const k of Object.keys(value)) if (!allowed.includes(k)) out.push(`${at}: unknown field "${k}"`);
}

function isEnvRef(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && Object.hasOwn(v, "$env");
}
function isSecretRef(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && Object.hasOwn(v, "$secret");
}

function checkConfigString(v: unknown, at: string, out: string[]): void {
  if (typeof v === "string") {
    if (v === "") out.push(`${at}: must not be empty`);
    return;
  }
  if (!isEnvRef(v)) {
    out.push(`${at}: must be a string or { "$env": NAME }`);
    return;
  }
  unknownFields(v, ["$env", "path", "default"], at, out);
  if (!nonEmpty(v.$env)) out.push(`${at}.$env: must name an environment variable`);
  if (v.path !== undefined && !nonEmpty(v.path)) out.push(`${at}.path: must be a non-empty string`);
  if (v.default !== undefined && typeof v.default !== "string") out.push(`${at}.default: must be a string`);
}

function checkCredential(v: unknown, at: string, demo: boolean, out: string[]): void {
  if (typeof v === "string") {
    // A literal credential in a document that is reviewed, diffed and signed is a leaked credential (ADR-0102).
    if (!demo) out.push(`${at}: a credential must be a { "$secret": NAME } reference, not a value (only a demo deployment may hold one)`);
    return;
  }
  if (!isSecretRef(v)) {
    out.push(`${at}: must be { "$secret": NAME }`);
    return;
  }
  unknownFields(v, ["$secret", "prefix", "default"], at, out);
  if (!nonEmpty(v.$secret)) out.push(`${at}.$secret: must name a secret`);
  if (v.prefix !== undefined && typeof v.prefix !== "string") out.push(`${at}.prefix: must be a string`);
  if (v.default !== undefined) {
    if (typeof v.default !== "string") out.push(`${at}.default: must be a string`);
    if (!demo) out.push(`${at}.default: a default credential is allowed only in a demo deployment`);
  }
}

function checkHttpSource(s: Record<string, unknown>, at: string, demo: boolean, out: string[]): void {
  unknownFields(s, ["kind", "system", "baseUrl", "auth", "types", "actions", "maxPages"], at, out);
  if (!nonEmpty(s.system)) out.push(`${at}.system: must name the system, as provenance reports it`);
  checkConfigString(s.baseUrl, `${at}.baseUrl`, out);
  if (!isRecord(s.types) || Object.keys(s.types).length === 0) out.push(`${at}.types: must map at least one Type`);
  else
    for (const [type, m] of Object.entries(s.types)) {
      if (!isRecord(m) || !nonEmpty(m.get) || !nonEmpty(m.id) || !isRecord(m.list) || !isRecord(m.fields)) out.push(`${at}.types["${type}"]: needs get, list, id and fields`);
    }
  if (s.actions !== undefined && !isRecord(s.actions)) out.push(`${at}.actions: must map Action names to requests`);
  if (s.maxPages !== undefined && !(Number.isInteger(s.maxPages) && (s.maxPages as number) > 0)) out.push(`${at}.maxPages: must be a positive integer`);
  if (s.auth !== undefined) {
    const a = s.auth;
    if (!isRecord(a)) {
      out.push(`${at}.auth: must be an object`);
      return;
    }
    if (a.kind === "header") {
      unknownFields(a, ["kind", "name", "value"], `${at}.auth`, out);
      if (!nonEmpty(a.name)) out.push(`${at}.auth.name: must name the header`);
      checkCredential(a.value, `${at}.auth.value`, demo, out);
    } else if (a.kind === "basic") {
      unknownFields(a, ["kind", "username", "password"], `${at}.auth`, out);
      if (!nonEmpty(a.username)) out.push(`${at}.auth.username: must be a non-empty string`);
      checkCredential(a.password, `${at}.auth.password`, demo, out);
    } else if (a.kind === "client-credentials") {
      unknownFields(a, ["kind", "tokenUrl", "clientId", "clientSecret", "scope"], `${at}.auth`, out);
      checkConfigString(a.tokenUrl, `${at}.auth.tokenUrl`, out);
      if (!nonEmpty(a.clientId)) out.push(`${at}.auth.clientId: must be a non-empty string`);
      checkCredential(a.clientSecret, `${at}.auth.clientSecret`, demo, out);
      if (a.scope !== undefined && typeof a.scope !== "string") out.push(`${at}.auth.scope: must be a string`);
    } else out.push(`${at}.auth.kind: must be "header", "basic" or "client-credentials"`);
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
const COLUMN_AS = ["text", "date", "date-time", "number", "integer", "boolean", "json"];

function checkPostgresSource(s: Record<string, unknown>, at: string, demo: boolean, out: string[]): void {
  unknownFields(s, ["kind", "system", "url", "types", "maxRows"], at, out);
  if (!nonEmpty(s.system)) out.push(`${at}.system: must name the system, as provenance reports it`);
  checkCredential(s.url, `${at}.url`, demo, out);
  if (s.maxRows !== undefined && !(Number.isInteger(s.maxRows) && (s.maxRows as number) > 0)) out.push(`${at}.maxRows: must be a positive integer`);
  if (!isRecord(s.types) || Object.keys(s.types).length === 0) {
    out.push(`${at}.types: must map at least one Type`);
    return;
  }
  for (const [type, m] of Object.entries(s.types)) {
    const t = `${at}.types["${type}"]`;
    if (!isRecord(m)) {
      out.push(`${t}: must be an object`);
      continue;
    }
    unknownFields(m, ["table", "id", "columns"], t, out);
    if (!nonEmpty(m.table) || !IDENT.test(m.table)) out.push(`${t}.table: must be a table name, or schema.table, of letters, digits and _`);
    if (!nonEmpty(m.id) || !IDENT.test(m.id) || m.id.includes(".")) out.push(`${t}.id: must be a column name`);
    if (!isRecord(m.columns)) {
      out.push(`${t}.columns: must map properties to columns`);
      continue;
    }
    for (const [prop, c] of Object.entries(m.columns)) {
      const cat = `${t}.columns["${prop}"]`;
      const column = typeof c === "string" ? c : isRecord(c) ? c.column : undefined;
      if (!nonEmpty(column) || !IDENT.test(column) || column.includes(".")) out.push(`${cat}: must be a column name, or { column, as?, map? }`);
      if (isRecord(c)) {
        unknownFields(c, ["column", "as", "map"], cat, out);
        if (c.as !== undefined && !COLUMN_AS.includes(c.as as string)) out.push(`${cat}.as: must be one of ${COLUMN_AS.join(", ")}`);
        if (c.map !== undefined && !isRecord(c.map)) out.push(`${cat}.map: must map stored values to model values`);
      }
    }
  }
}

function checkSigning(v: unknown, at: string, demo: boolean, out: string[]): void {
  if (!isRecord(v)) {
    out.push(`${at}: must be { keyId, key }`);
    return;
  }
  unknownFields(v, ["keyId", "key", "everyRows", "everySeconds"], at, out);
  if (!nonEmpty(v.keyId)) out.push(`${at}.keyId: must name the key`);
  checkCredential(v.key, `${at}.key`, demo, out);
  if (v.everyRows !== undefined && !(Number.isInteger(v.everyRows) && (v.everyRows as number) > 0)) out.push(`${at}.everyRows: must be a positive integer`);
  if (v.everySeconds !== undefined && !(Number.isInteger(v.everySeconds) && (v.everySeconds as number) > 0)) out.push(`${at}.everySeconds: must be a positive integer`);
}

function checkStore(v: unknown, at: string, kinds: readonly string[], demo: boolean, out: string[], extra: readonly string[] = []): Record<string, unknown> | undefined {
  if (!isRecord(v)) {
    out.push(`${at}: must be an object`);
    return undefined;
  }
  if (!kinds.includes(v.kind as string)) {
    out.push(`${at}.kind: must be ${kinds.map((k) => `"${k}"`).join(" or ")}`);
    return undefined;
  }
  if (v.kind === "memory") unknownFields(v, ["kind", ...extra.filter((e) => e !== "url" && e !== "keyPrefix" && e !== "ttlMs" && e !== "retainDays")], at, out);
  else {
    unknownFields(v, ["kind", "url", ...extra], at, out);
    checkCredential(v.url, `${at}.url`, demo, out);
  }
  return v;
}

function checkState(state: unknown, demo: boolean, out: string[]): void {
  const audit = isRecord(state) ? state.audit : undefined;
  if (state !== undefined && !isRecord(state)) {
    out.push("state: must be an object");
    return;
  }
  if (isRecord(state)) unknownFields(state, ["audit", "workflows", "cache", "rateLimit"], "state", out);
  // A deployment for real traffic keeps its audit trail, and signs it, so a cut-short trail can be told from one that ended (ADR-0106).
  if (!demo && (!isRecord(audit) || audit.kind !== "postgres")) out.push('state.audit: a deployment that is not a demo must keep its audit trail: { "kind": "postgres", "url": { "$secret": ... }, "signing": ... }');
  if (audit !== undefined) {
    const a = checkStore(audit, "state.audit", ["memory", "postgres"], demo, out, ["signing", "verifyKeys", "retainDays"]);
    if (a) {
      if (a.signing !== undefined) checkSigning(a.signing, "state.audit.signing", demo, out);
      else if (!demo && a.kind === "postgres") out.push("state.audit.signing: a deployment that is not a demo must sign its audit checkpoints");
      if (a.verifyKeys !== undefined && (!isRecord(a.verifyKeys) || !Object.values(a.verifyKeys).every((k) => typeof k === "string" && k.includes("PUBLIC KEY")))) out.push("state.audit.verifyKeys: must map key ids to PEM public keys");
      if (isRecord(a.signing) && nonEmpty(a.signing.keyId) && !(isRecord(a.verifyKeys) && Object.hasOwn(a.verifyKeys, a.signing.keyId)))
        out.push(`state.audit.verifyKeys: must hold the public key for "${a.signing.keyId}", the key checkpoints are signed with`);
      if (a.retainDays !== undefined && !(Number.isInteger(a.retainDays) && (a.retainDays as number) > 0)) out.push("state.audit.retainDays: must be a positive integer");
    }
  }
  if (!isRecord(state)) return;
  if (state.workflows !== undefined) checkStore(state.workflows, "state.workflows", ["memory", "postgres"], demo, out);
  if (state.cache !== undefined) {
    const c = checkStore(state.cache, "state.cache", ["memory", "redis"], demo, out, ["keyPrefix", "ttlMs"]);
    if (c?.keyPrefix !== undefined && !nonEmpty(c.keyPrefix)) out.push("state.cache.keyPrefix: must be a non-empty string");
    if (c?.ttlMs !== undefined && !(Number.isInteger(c.ttlMs) && (c.ttlMs as number) > 0)) out.push("state.cache.ttlMs: must be a positive integer");
  }
  if (state.rateLimit !== undefined) {
    const r = state.rateLimit;
    if (!isRecord(r)) out.push("state.rateLimit: must be an object");
    else {
      unknownFields(r, ["kind", "url", "capacity", "refillPerSecond", "keyPrefix"], "state.rateLimit", out);
      if (r.kind !== "memory" && r.kind !== "redis") out.push('state.rateLimit.kind: must be "memory" or "redis"');
      if (r.kind === "redis") checkCredential(r.url, "state.rateLimit.url", demo, out);
      else if (r.url !== undefined) out.push("state.rateLimit.url: only a redis rate limit has one");
      if (!(Number.isInteger(r.capacity) && (r.capacity as number) >= 1)) out.push("state.rateLimit.capacity: must be an integer of at least 1");
      if (!(typeof r.refillPerSecond === "number" && r.refillPerSecond >= 0)) out.push("state.rateLimit.refillPerSecond: must be a number of at least 0");
      if (r.keyPrefix !== undefined && !nonEmpty(r.keyPrefix)) out.push("state.rateLimit.keyPrefix: must be a non-empty string");
    }
  }
}

function checkApplications(apps: unknown, out: string[]): void {
  if (apps === undefined) return;
  if (!Array.isArray(apps)) {
    out.push("applications: must be a list");
    return;
  }
  const names = new Set<string>();
  apps.forEach((a, i) => {
    const at = `applications[${i}]`;
    if (!isRecord(a)) {
      out.push(`${at}: must be an object`);
      return;
    }
    unknownFields(a, ["name", "module", "port"], at, out);
    if (!nonEmpty(a.name) || !NAME.test(a.name)) out.push(`${at}.name: lower case letters, digits, '.', '-' and '_'`);
    else if (names.has(a.name)) out.push(`${at}: ${a.name} is listed twice`);
    else names.add(a.name);
    if (a.module !== undefined && !nonEmpty(a.module)) out.push(`${at}.module: must be an installed package's specifier`);
    checkConfigString(a.port, `${at}.port`, out);
  });
}

/** Every problem with `doc` as a deployment. Empty means it is well formed; `buildHost` still checks it against its packs and extensions. */
export function validateDeployment(doc: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(doc)) return ["deployment: must be an object"];
  unknownFields(doc, ["format", "name", "description", "demo", "packs", "extensions", "sources", "state", "applications", "policies", "classification", "identity", "personas", "runtime", "trust", "consumers"], "deployment", out);
  if (doc.format !== DEPLOYMENT_FORMAT) out.push(`format: must be "${DEPLOYMENT_FORMAT}"`);
  if (!nonEmpty(doc.name) || !NAME.test(doc.name)) out.push("name: lower case letters, digits, '.', '-' and '_'");
  if (doc.description !== undefined && typeof doc.description !== "string") out.push("description: must be a string");
  if (doc.demo !== undefined && typeof doc.demo !== "boolean") out.push("demo: must be true or false");
  const demo = doc.demo === true;

  if (!Array.isArray(doc.packs) || doc.packs.length === 0) out.push("packs: must list at least one pack");
  else {
    const seen = new Set<string>();
    doc.packs.forEach((p, i) => {
      if (!isRecord(p) || !nonEmpty(p.name) || !nonEmpty(p.version)) {
        out.push(`packs[${i}]: needs a name and a version`);
        return;
      }
      unknownFields(p, ["name", "version", "digest", "file"], `packs[${i}]`, out);
      if (seen.has(p.name)) out.push(`packs[${i}]: ${p.name} is listed twice`);
      seen.add(p.name);
      if (p.digest !== undefined && !(typeof p.digest === "string" && /^sha256:[0-9a-f]{64}$/i.test(p.digest))) out.push(`packs[${i}].digest: must be sha256:<64 hex>`);
      if (p.file !== undefined && !nonEmpty(p.file)) out.push(`packs[${i}].file: must be a path`);
    });
  }

  const extensions = new Set<string>();
  if (doc.extensions !== undefined) {
    if (!Array.isArray(doc.extensions) || !doc.extensions.every(nonEmpty)) out.push("extensions: must be a list of extension names");
    else for (const e of doc.extensions) extensions.add(e);
  }
  const needsExtension = (name: unknown, at: string) => {
    if (!nonEmpty(name)) out.push(`${at}: must name an extension`);
    else if (!extensions.has(name)) out.push(`${at}: "${name}" is not among the deployment's extensions`);
  };

  if (!isRecord(doc.sources)) out.push("sources: must map data source ids to their systems");
  else
    for (const [id, s] of Object.entries(doc.sources)) {
      const at = `sources["${id}"]`;
      if (!isRecord(s)) out.push(`${at}: must be an object`);
      else if (s.kind === "http") checkHttpSource(s, at, demo, out);
      else if (s.kind === "postgres") checkPostgresSource(s, at, demo, out);
      else if (s.kind === "extension") {
        unknownFields(s, ["kind", "extension", "system"], at, out);
        needsExtension(s.extension, `${at}.extension`);
      } else out.push(`${at}.kind: must be "http", "postgres" or "extension"`);
    }

  if (!isRecord(doc.policies)) out.push("policies: must map rule names to policy expressions");
  else for (const [name, expr] of Object.entries(doc.policies)) out.push(...validatePolicyExpression(expr, `policies["${name}"]`));

  if (doc.classification !== undefined) {
    const c = doc.classification;
    if (!isRecord(c)) out.push("classification: must be an object");
    else if (c.kind === "deny-marked") unknownFields(c, ["kind"], "classification", out);
    else if (c.kind === "demo-linear") {
      unknownFields(c, ["kind"], "classification", out);
      if (!demo) out.push("classification: the demonstration ordering is allowed only in a demo deployment");
    } else if (c.kind === "linear") {
      unknownFields(c, ["kind", "name", "levels"], "classification", out);
      if (!nonEmpty(c.name)) out.push("classification.name: must name the scheme");
      if (!Array.isArray(c.levels) || c.levels.length === 0 || !c.levels.every(nonEmpty) || new Set(c.levels).size !== c.levels.length) out.push("classification.levels: must be distinct markings, lowest first");
    } else out.push('classification.kind: must be "deny-marked", "linear" or "demo-linear"');
  }

  const personas = isRecord(doc.personas) ? doc.personas : {};
  if (doc.personas !== undefined) {
    if (!isRecord(doc.personas)) out.push("personas: must map names to identities");
    else
      for (const [name, p] of Object.entries(doc.personas)) {
        if (!isRecord(p) || !nonEmpty(p.subjectId) || !Array.isArray(p.roles) || !p.roles.every(nonEmpty) || !isRecord(p.attributes)) out.push(`personas["${name}"]: needs subjectId, roles and attributes`);
        else if (p.clearance !== undefined && !nonEmpty(p.clearance)) out.push(`personas["${name}"].clearance: must be a marking`);
      }
  }

  const id = doc.identity;
  if (!isRecord(id)) out.push("identity: must say how a bearer token becomes an identity");
  else if (id.kind === "oidc") {
    unknownFields(id, ["kind", "issuer", "audience", "rolesClaim", "roleMap", "clearanceClaim", "jwksUrl", "resource", "scopes", "allowAnonymous"], "identity", out);
    checkConfigString(id.issuer, "identity.issuer", out);
    if (id.audience !== undefined) checkConfigString(id.audience, "identity.audience", out);
    // A token for another application of the same provider must not read this deployment's data (ADR-0116).
    else if (!demo) out.push('identity.audience: required outside a demo, or a token the provider issued for any other application is accepted: the value your provider puts in "aud" for this server (often its address, or an application id)');
    if (id.jwksUrl !== undefined) checkConfigString(id.jwksUrl, "identity.jwksUrl", out);
    if (id.resource !== undefined) checkConfigString(id.resource, "identity.resource", out);
    if (typeof id.resource === "string" && !/^https?:\/\/[^/?#]+\/?$/.test(id.resource)) out.push("identity.resource: must be the server's origin, such as https://typesys.example.com, with no path");
    if (id.scopes !== undefined && (!Array.isArray(id.scopes) || !id.scopes.every(nonEmpty))) out.push("identity.scopes: must be a list of scope names");
    if (id.allowAnonymous !== undefined && typeof id.allowAnonymous !== "boolean") out.push("identity.allowAnonymous: must be true or false");
    if (id.roleMap !== undefined) {
      if (!isRecord(id.roleMap)) out.push("identity.roleMap: must map the provider's group or role names to lists of roles");
      else
        for (const [k, v] of Object.entries(id.roleMap))
          if (!Array.isArray(v) || !v.every(nonEmpty)) out.push(`identity.roleMap.${k}: must be a list of roles`);
    }
    if (id.rolesClaim !== undefined && !nonEmpty(id.rolesClaim)) out.push("identity.rolesClaim: must be a claim path");
    if (id.clearanceClaim !== undefined && !nonEmpty(id.clearanceClaim)) out.push("identity.clearanceClaim: must be a claim path");
  } else if (id.kind === "tokens") {
    unknownFields(id, ["kind", "tokens"], "identity", out);
    if (!demo) out.push("identity: fixed tokens grant roles to anyone who knows them, so they are allowed only in a demo deployment");
    if (!isRecord(id.tokens)) out.push("identity.tokens: must map tokens to persona names");
    else for (const [token, persona] of Object.entries(id.tokens)) if (!nonEmpty(persona) || !Object.hasOwn(personas, persona)) out.push(
          `identity.tokens: token "${token.slice(0, 4)}…" names ${nonEmpty(persona) ? `persona "${persona}", which personas does not declare: add "personas": { "${persona}": { "subjectId": "...", "roles": ["..."], "attributes": {} } }` : "no persona"}`
        );
  } else if (id.kind === "extension") {
    unknownFields(id, ["kind", "extension"], "identity", out);
    needsExtension(id.extension, "identity.extension");
  } else out.push('identity.kind: must be "oidc", "tokens" or "extension"');

  if (doc.runtime !== undefined) {
    const r = doc.runtime;
    if (!isRecord(r)) out.push("runtime: must be an object");
    else {
      unknownFields(r, ["callTimeoutMs", "inspectionPolicy", "securityProfile", "telemetry", "requestLog"], "runtime", out);
      if (r.requestLog !== undefined && typeof r.requestLog !== "boolean") out.push("runtime.requestLog: must be true or false");
      if (r.telemetry !== undefined) {
        const t = r.telemetry;
        if (!isRecord(t)) out.push("runtime.telemetry: must be { \"otlpEndpoint\": ... }");
        else {
          unknownFields(t, ["otlpEndpoint", "serviceName", "metricsIntervalSeconds"], "runtime.telemetry", out);
          checkConfigString(t.otlpEndpoint, "runtime.telemetry.otlpEndpoint", out);
          if (typeof t.otlpEndpoint === "string" && !/^https?:\/\//.test(t.otlpEndpoint)) out.push("runtime.telemetry.otlpEndpoint: must be an http(s) URL, such as http://otel-collector:4318");
          if (t.serviceName !== undefined && !nonEmpty(t.serviceName)) out.push("runtime.telemetry.serviceName: must be a non-empty string");
          if (t.metricsIntervalSeconds !== undefined && !(Number.isInteger(t.metricsIntervalSeconds) && (t.metricsIntervalSeconds as number) >= 1))
            out.push("runtime.telemetry.metricsIntervalSeconds: must be a whole number of seconds, at least 1");
        }
      }
      if (r.securityProfile !== undefined && r.securityProfile !== "high-assurance-v1") out.push('runtime.securityProfile: must be "high-assurance-v1"');
      if (r.callTimeoutMs !== undefined && !(Number.isInteger(r.callTimeoutMs) && (r.callTimeoutMs as number) > 0)) out.push("runtime.callTimeoutMs: must be a positive integer");
      if (r.inspectionPolicy !== undefined && (!nonEmpty(r.inspectionPolicy) || !isRecord(doc.policies) || !Object.hasOwn(doc.policies, r.inspectionPolicy)))
        out.push("runtime.inspectionPolicy: must name one of the deployment's policies");
    }
  }

  if (doc.trust !== undefined) {
    const t = doc.trust;
    if (!isRecord(t)) out.push("trust: must be an object");
    else {
      unknownFields(t, ["keys", "revokedKeys", "revokedDigests"], "trust", out);
      if (t.keys !== undefined && (!isRecord(t.keys) || !Object.values(t.keys).every((k) => typeof k === "string" && k.includes("PUBLIC KEY")))) out.push("trust.keys: must map key ids to PEM public keys");
      for (const k of ["revokedKeys", "revokedDigests"] as const) if (t[k] !== undefined && !isRecord(t[k])) out.push(`trust.${k}: must be an object`);
    }
  }

  checkState(doc.state, demo, out);
  checkApplications(doc.applications, out);

  if (doc.consumers !== undefined) {
    if (!Array.isArray(doc.consumers)) out.push("consumers: must be a list");
    else {
      const names = new Set<string>();
      doc.consumers.forEach((c, i) => {
        if (!isRecord(c) || !nonEmpty(c.name) || !isRecord(c.contract)) {
          out.push(`consumers[${i}]: needs a name and a contract`);
          return;
        }
        unknownFields(c, ["name", "contract"], `consumers[${i}]`, out);
        if (names.has(c.name)) out.push(`consumers[${i}]: ${c.name} is listed twice`);
        names.add(c.name);
        for (const [type, range] of Object.entries(c.contract)) if (!nonEmpty(range)) out.push(`consumers[${i}].contract["${type}"]: must be a semver range`);
      });
    }
  }
  return out;
}

/** Throws `DeploymentError` with every problem, or returns `doc` typed. */
export function parseDeployment(doc: unknown): Deployment {
  const problems = validateDeployment(doc);
  if (problems.length > 0) throw new DeploymentError(problems);
  return doc as Deployment;
}

/**
 * The build id (ADR-0101): SHA-256 over the canonical deployment and the
 * digest of every pack it installed. References are hashed, never the
 * values they resolve to, so rotating a secret is not a new build, and a
 * changed model is, even when the deployment file is unchanged.
 */
export function buildIdOf(deployment: Deployment, packDigests: readonly string[]): string {
  const body = canonical({ deployment: JSON.parse(JSON.stringify(deployment)) as unknown, packs: [...packDigests].sort() });
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
