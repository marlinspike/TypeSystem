import { AsyncLocalStorage } from "node:async_hooks";
import { ReadCoalescer } from "./read-coalescer.js";
import { createHmac } from "node:crypto";
import { ulid } from "ulid";
import type { SemanticRegistry } from "../registry/registry.js";
import { MappingResolver } from "./mapping-resolver.js";
import type { Adapter, AdapterQueryResult, ResolvedProperties, RelatedRef } from "./adapter.js";
import { audienceIdentity, type Identity, type PolicyDecision, type PolicyEngine, type PolicyRequest, type PolicyResource } from "../model/policy.js";
import type { TypeDefinition, ComputedPropertyDefinition } from "../model/type.js";
import type { ActionDefinition } from "../model/action.js";
import type { RelationshipDefinition } from "../model/relationship.js";
import type { Mapping } from "../model/data-source.js";
import type { ProvenanceRef } from "../model/provenance.js";
import type { SemanticQuery, QueryFilter, QueryInclude, QueryResult, SortKey, SearchSpec, SemanticAggregateQuery, AggregateResult } from "../model/query.js";
import type { ComputeContext, ActionContext } from "../model/context.js";
import { InputValidator, type QueryLimits } from "./input-validation.js";
import { AdapterTimeoutError, AdapterUnavailableError, AuthorizationError, AuthorizationPlanError, CircuitOpenError, InvalidInputError, NotFoundError, ObjectNotFoundError, PreconditionFailedError, RateLimitExceededError, AggregationNotSupportedError, SourceRefusedError } from "./errors.js";
import { AdapterResilience, type ResiliencePolicy } from "./resilience.js";
import { DENY_MARKED_DATA, isMarked, memberMarkings, objectMarkings, valueMarkings, type ClassificationScheme } from "./classification.js";
import { type Cache, NoopCache } from "./cache.js";
import { HIGH_ASSURANCE_V2, SECURITY_PROFILES, SecurityProfileError, type PlanAssurance, type SecurityProfile } from "./security-profile.js";
import { DISCOVERY_MODES, isAnonymous, narrowModel, type Discovery, type DiscoveryGate, type Withheld } from "./discovery.js";
import { buildInspection, type InspectionGate, type InspectionOptions, type ModelInspection } from "./inspection.js";
import { EXPLANATION_CAVEAT, EXPLANATION_FORMAT, explainShapeError, summarize, type ExplainOptions, type ExplainQuestion, type Explanation, type ExplanationOutcome, type Finding, type ObservedDecision, type TraceEntry } from "./explain.js";
import { composedProperties, describeModel, type DescribeModelOptions, type ModelDescription } from "../registry/model-description.js";
import { type RateLimiter, NoopRateLimiter } from "./rate-limiter.js";
import { mapWithConcurrency, mapWithConcurrencySettled, Semaphore } from "./concurrency.js";
import { filterProperties, matchesFilter } from "./filter.js";
import { applyProjection, applySort } from "./query-ops.js";
import { decodeScanCursor, encodeScanCursor, isScanCursor, splitFilter, type ExecutionPlan, type ExecutionStep } from "./execution-plan.js";
import { instrumentOperation, annotateActiveSpan } from "../observability/tracing.js";
import { recordPolicyDecision, recordPolicyFaults, recordCacheResult, recordPlanDefect } from "../observability/metrics.js";
import {
  allPlans,
  checkPlan,
  isExact,
  limitationsOf,
  planAdmits,
  predicatePlan,
  predicateToFilter,
  predicateAttributes,
  refitPredicate,
  unknownPlan,
  type AuthorizationPlan
} from "../policy/authorization-plan.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 20;

/** The adapter reads (idempotent, always safe to retry) versus the one write path. Drives retry eligibility in `getAdapter` (ADR-0026). */
const RETRYABLE_ADAPTER_READS = new Set(["resolveProperties", "queryByType", "resolveRelationship", "aggregate"]);

/**
 * Whether one intercepted adapter call may be retried. Reads always may;
 * `executeAction` only if the Action declared itself idempotent
 * (`idempotency !== "none"`, ADR-0005/0026), so the resilience layer can
 * never turn one side effect into two silently. Anything else (an unknown
 * method) is treated as not retryable.
 */
function isRetryableAdapterCall(prop: string | symbol, args: unknown[]): boolean {
  if (typeof prop !== "string") return false;
  if (RETRYABLE_ADAPTER_READS.has(prop)) return true;
  if (prop === "executeAction") {
    const action = args[0] as ActionDefinition | undefined;
    return !!action && action.idempotency !== "none";
  }
  return false;
}

export interface ResolvedObject {
  typeName: string;
  objectId: string;
  values: Record<string, unknown>;
  provenance?: ProvenanceRef[];
  /** Parts of the answer left out because their source failed (ADR-0072): only optional relationships' includes. */
  unavailable?: UnavailablePart[];
}

/** What is missing from an answer, from which source, and why (ADR-0072). */
export interface UnavailablePart {
  /** The include left out: a relationship name of this object. */
  path: string;
  dataSourceId: string;
  reason: "unavailable" | "timeout" | "refused-by-source";
  message: string;
}

/**
 * The source whose adapter call raised a failure, set where every adapter
 * call passes (`getAdapter`) by the innermost one: a relationship resolved
 * through one source can fail reading its targets from another (ADR-0094).
 */
const FAILED_SOURCE = new WeakMap<object, string>();
/** What a plan says in place of a source's id to a caller who may not inspect (ADR-0088). */
export const SOURCE_WITHHELD = "(withheld)";

/** A plan as a caller who may not inspect is told it: every step's source withheld. */
function withheldSources(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.op === "scan" || step.op === "include" ? { ...step, dataSourceId: SOURCE_WITHHELD } : step.op === "merge-overrides" ? { ...step, dataSourceIds: step.dataSourceIds.map(() => SOURCE_WITHHELD) } : step))
  };
}

/** Each Type definition's declared stored properties (ADR-0095), composed once per definition object. */
const DECLARED = new WeakMap<TypeDefinition, ReadonlySet<string>>();

/** A source failing to answer, as opposed to the caller being refused or the request being wrong. */
function sourceFailure(err: unknown): UnavailablePart["reason"] | undefined {
  if (err instanceof SourceRefusedError) return "refused-by-source";
  if (err instanceof AdapterTimeoutError) return "timeout";
  if (err instanceof AdapterUnavailableError || err instanceof CircuitOpenError) return "unavailable";
  return undefined;
}

/** An object's stored values as its policies see them (ADR-0030): frozen, so no rule can alter what the caller is later returned. */
type Attributes = Readonly<Record<string, unknown>>;

/** One authorized object read, with the attributes it was authorized on — what its includes authorize against. */
interface AuthorizedRead {
  object: ResolvedObject;
  attributes: Attributes;
}

function snapshot(values: Record<string, unknown>): Attributes {
  return Object.freeze({ ...values });
}

/** A Type's object-level read policy. An undeclared one names a rule nobody registers, so it denies (ADR-0009). */
function objectPolicyOf(typeDef: TypeDefinition): string {
  return typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
}

/** A property's or relationship's own policy, if it declares one — which narrows the object policy, never replaces it (ADR-0030). */
function memberPolicyOf(typeDef: TypeDefinition, member: string): string | undefined {
  return typeDef.schema["x-policy"]?.propertyPolicies?.[member];
}

/**
 * A withheld derivation's audit details (ADR-0052): the declared inputs that
 * withhold it, and, apart, the inputs further up that withhold one of those
 * and that a release of it does not lift.
 */
function derivationInputs(cp: ComputedPropertyDefinition, withheld: readonly string[]): { inputs: string[]; upstream?: string[] } {
  const upstream = withheld.filter((name) => !cp.dependsOn.includes(name));
  return { inputs: withheld.filter((name) => cp.dependsOn.includes(name)), ...(upstream.length > 0 ? { upstream } : {}) };
}

/** How identifiers — the caller's, and the objects it touches — reach telemetry (ADR-0045, ADR-0047). */
export type TelemetryIdentity = "none" | "clear" | { mode: "pseudonymous"; key: Uint8Array };

/**
 * The one place identifiers enter a span (ADR-0047). Every subject and object
 * id goes through it, and so does every error a span records: under anything
 * but `"clear"`, only the error's class name, since runtime messages name
 * objects and subjects.
 */
interface Telemetry {
  subject(identity: Identity): Record<string, string>;
  object(typeName: string, objectId: string): Record<string, string>;
  readonly redactErrors: boolean;
}

function telemetryOf(policy: unknown): Telemetry {
  if (policy === "clear") {
    return { subject: (identity) => ({ "typesys.identity.subject_id": identity.subjectId }), object: (_type, objectId) => ({ "typesys.object_id": objectId }), redactErrors: false };
  }
  if (policy === "none") return { subject: () => ({}), object: () => ({}), redactErrors: true };
  const { mode, key } = (typeof policy === "object" && policy !== null ? policy : {}) as { mode?: unknown; key?: unknown };
  if (mode !== "pseudonymous") throw new TypeError(`telemetryIdentity must be "none", "clear", or { mode: "pseudonymous", key }`);
  if (!(key instanceof Uint8Array) || key.length < 32) throw new TypeError("telemetryIdentity's pseudonym key must be at least 32 bytes");
  const secret = Buffer.from(key);
  // Tagged, JSON-encoded inputs: a subject's pseudonym never equals an object's, and one id in two Types gives two.
  const pseudonym = (parts: string[]) => createHmac("sha256", secret).update(JSON.stringify(parts), "utf8").digest().subarray(0, 16).toString("base64url");
  return {
    subject: (identity) => ({ "typesys.identity.pseudonym": pseudonym(["subject", identity.subjectId]) }),
    object: (typeName, objectId) => ({ "typesys.object_pseudonym": pseudonym(["object", typeName, objectId]) }),
    redactErrors: true
  };
}

/** The public runtime operations, as audit rows name them (ADR-0042). */
export type RuntimeOperation = "getObject" | "getRelationship" | "getProvenance" | "query" | "aggregate" | "explainQuery" | "listActions" | "invokeAction" | "previewAction" | "describeModel" | "inspectModel" | "explain";

/** Why a previewed Action would not run (ADR-0053), in the order the runtime checks. */
export interface ActionBlocker {
  kind: "authorization" | "target" | "input" | "precondition";
  message: string;
}

/**
 * What `invokeAction` would do with this input, as this caller, decided
 * exactly as it would be and with no side effect (ADR-0053). Only a caller
 * the Action's policy allows learns about input and preconditions.
 */
export interface ActionPreview {
  action: string;
  version: string;
  /** The object an instance-scoped Action would act on, when the input names one. */
  target?: { typeName: string; objectId: string };
  authorized: boolean;
  /** Whether the input matches the Action's `inputSchema`; `null` when not checked. */
  inputValid: boolean | null;
  /** Each precondition in order: `null` when not evaluated, since an earlier gate already blocks. */
  preconditions: { description: string; satisfied: boolean | null }[];
  blockers: ActionBlocker[];
  wouldExecute: boolean;
  /** What the Action declares it does, from its definition (ADR-0005). */
  effects: { sideEffects: ActionDefinition["sideEffects"]; idempotency: ActionDefinition["idempotency"]; auditRequired: boolean };
}

/** One Action as `listActions` reports it. `instanceScoped` Actions are decided per object (ADR-0053). */
export interface ListedAction {
  action: ActionDefinition;
  authorized: boolean;
  instanceScoped: boolean;
}

/** A `ListedAction` as it crosses a wire (MCP, the SDK): what a caller needs to choose an Action, without its definition's internals. */
export interface ActionSummary {
  name: string;
  description: string;
  authorized: boolean;
  instanceScoped: boolean;
  sideEffects: ActionDefinition["sideEffects"];
  idempotency: ActionDefinition["idempotency"];
}

export function summarizeAction({ action, authorized, instanceScoped }: ListedAction): ActionSummary {
  return { name: action.name, description: action.description, authorized, instanceScoped, sideEffects: action.sideEffects, idempotency: action.idempotency };
}

/** The object an instance-scoped invocation was authorized against. */
interface ActionTarget {
  typeName: string;
  objectId: string;
  attributes: Attributes;
  typeDef: TypeDefinition;
  stored: ResolvedProperties;
  /** Per property, whether the caller's read of the target shows it; decided once, on first use. */
  readable?: Map<string, Promise<boolean>>;
  classified?: Promise<ReadonlySet<string>>;
}

/**
 * How `query` treats a read policy it can't plan exactly (ADR-0038):
 * `"post-filter"` reads with whatever plan there is and decides every object
 * after the read; `"require-exact"` refuses the query instead.
 */
export type RowSecurity = "post-filter" | "require-exact";

/** What `explainQuery` reports (ADR-0038). Runtime-only: it reveals what the policy tests and the subject's own values. */
export interface QueryPlanReport {
  typeName: string;
  policyName: string;
  /** The security profile in force (ADR-0046), or `null`. */
  securityProfile: string | null;
  rowSecurity: RowSecurity;
  /** The plan as `query` would apply it, fitted to where the Type's data is. */
  plan: AuthorizationPlan;
  /** How `query` would run: each step in order, where each part of the filter runs, and what to expect (ADR-0054). */
  execution: ExecutionPlan;
  /** Properties the query selects or orders by: a value's own provenance marking on one can still drop a row (ADR-0032). */
  probes: string[];
  guarantees: {
    /** The plan admits exactly the objects the policy allows. */
    exact: boolean;
    /** No page comes back short for a reason the caller can't see: exact, and nothing probed. */
    paginationPrivate: boolean;
    /** An aggregate by this subject would run over exactly the rows it may read. */
    aggregationSafe: boolean;
    /** The post-read check may drop objects — it always runs; this says whether it can matter. */
    postFilterRequired: boolean;
  };
}

/** At most 16 fault strings of at most 200 characters each, from whatever an engine answered (ADR-0043). */
function boundedFaults(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((f): f is string => typeof f === "string").slice(0, 16).map((f) => f.slice(0, 200));
}

/** The ABAC combinators' own fault: fixed text and a number, so it can carry nothing else (ADR-0047). */
const ANYOF_FAULT = /^anyOf alternative \d{1,4} failed to evaluate$/;

/**
 * Under a security profile, an engine's fault text is kept only in the
 * combinators' fixed form; anything else — which a custom engine may have
 * filled with whatever its error paths held — becomes one fixed code (ADR-0047).
 */
function enumeratedFaults(faults: string[]): string[] {
  return faults.map((f) => (ANYOF_FAULT.test(f) ? f : "external-policy-fault"));
}

/** What a scheme's `join` must answer for marked data: a non-empty list of markings (ADR-0041). */
function isLabel(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((m) => typeof m === "string");
}

/** A plan in an audit row or a span: its kind, exactness, and limitation codes — never predicate literals or identity values. */
/** What adapters protect at rest (ADR-0036): `any` for a bundle's caching, `has` for one field. */
interface ProtectedFields {
  readonly any: boolean;
  has(field: string): boolean;
}

function planSummary(plan: AuthorizationPlan): { plan: AuthorizationPlan["kind"]; exact: boolean; limitations: string[] } {
  return { plan: plan.kind, exact: isExact(plan), limitations: limitationsOf(plan).map((l) => l.code) };
}

/** The reason a clearance check gives the caller: never the marking, which can itself be sensitive (ADR-0032). */
const CLEARANCE_REASON = "Requires a higher clearance";

/**
 * The principals a decision about `identity` is made for (ADR-0067): the
 * subject alone, or the subject and the audience it reads for, each as a
 * principal of its own. The subject is decided without its audience, so no
 * rule can mistake one for the other.
 */
function principalsOf(identity: Identity): { person: Identity; audience?: Identity } {
  if (!identity.audience) return { person: identity };
  const { audience, ...person } = identity;
  return { person, audience: audienceIdentity(audience) };
}

/** The call currently executing, if any: the runtime running it, its concurrency budget, and the operation it is (see `withRequest`). */
interface RequestContext {
  owner: SemanticRuntime;
  budget: Semaphore;
  operation: RuntimeOperation;
  /** Computed properties' adapter reads, coalesced for this request when the runtime is so configured (ADR-0062). */
  reads?: ReadCoalescer;
  /**
   * Set while an explanation runs (ADR-0089): every decision the runtime makes
   * is also kept here, with its policy's name, and the subject's own rate limit
   * is not charged for an investigation of them.
   */
  explanation?: { readonly investigator: string; readonly trace: TraceEntry[] };
  /** Set on the investigator's own reads during an explanation, which was charged to them once when it started (ADR-0089). */
  charged?: true;
}

/**
 * One for the process, never one per runtime. On Node 22 every live
 * `AsyncLocalStorage` is propagated on every promise the process creates and
 * is never released, so a store per instance made every await in the
 * process slower with each runtime ever constructed (a test suite that
 * builds hundreds slowed a query loop seventeenfold). Each context names the
 * runtime it belongs to, so instances still never share a budget or an
 * operation.
 */
const requests = new AsyncLocalStorage<RequestContext>();

/** Marks a decision the subject's audience refused (ADR-0067), for an explanation's trace only: never serialized. */
const REFUSED_BY_AUDIENCE = Symbol("refusedByAudience");

function notAuthorized(action: "read" | "invoke", resource: PolicyResource, reason: string | undefined, identity: Identity): AuthorizationError {
  const target = resource.actionName ?? resource.propertyPath ?? resource.objectId;
  // A caller reading for an audience (a model, ADR-0067) is told one thing whatever was refused, and why: whether
  // the person or the audience was refused would say whether the row exists and the person may read it. The
  // audit row keeps the reason.
  const told = identity.audience ? `Refused while reading for ${identity.audience.id}` : reason;
  return new AuthorizationError(`Not authorized: ${action} ${resource.typeName}${target ? `/${target}` : ""}`, told);
}

/**
 * The single boundary through which every consumer — a human application
 * or an AI agent over MCP — reads objects, navigates relationships,
 * queries, and invokes Actions. Policy and audit are enforced exactly
 * once, here, never re-implemented by a transport-specific layer (see
 * ADR-0009 and ADR-0012).
 */
/**
 * Everything optional about a `SemanticRuntime`. Every field defaults to
 * the behavior the runtime had before that feature existed, so `{}` (or
 * omitting the argument) is always safe.
 */
export interface SemanticRuntimeOptions {
  /**
   * Omit to preserve pre-ADR-0016 "always live" behavior exactly — a `NoopCache` always misses. A
   * cache that isn't `confidential` never receives encrypted or marked data (ADR-0036).
   */
  cache?: Cache;
  /** Fallback TTL for any `resolutionMode: "cached"` Mapping/relationship/computed property with no `cacheTtlMs` of its own. Default 30s. */
  defaultCacheTtlMs?: number;
  /** Omit to preserve pre-ADR-0019 "unlimited" behavior exactly — a `NoopRateLimiter` never rejects. Checked once per call, keyed by `identity.subjectId` (see ADR-0019). */
  rateLimiter?: RateLimiter;
  /**
   * Caps how many adapter calls one top-level runtime call (and everything it fans out into:
   * relationships, include trees, computed properties) has in flight at once. Default 20.
   * See ADR-0019 and `withRequest`.
   */
  maxConcurrency?: number;
  /** Overrides for any of `DEFAULT_QUERY_LIMITS` — page size, include count and depth, filter depth/size (see `input-validation.ts`). */
  queryLimits?: Partial<QueryLimits>;
  /**
   * Timeout, retry, and circuit-breaker policy applied to every adapter call
   * (ADR-0026). Omit to preserve pre-ADR-0026 behavior exactly — no deadline,
   * no retry, no breaker. `RECOMMENDED_RESILIENCE_POLICY` is a sane starting
   * point to pass here.
   */
  resilience?: ResiliencePolicy;
  /**
   * How a subject's clearance compares to data markings (ADR-0032). Omitted,
   * it is `DENY_MARKED_DATA` (ADR-0034): unmarked data reads as before and
   * marked data is denied until a deployment chooses a scheme — so
   * classification can't be switched off by forgetting to configure it.
   */
  classification?: ClassificationScheme;
  /**
   * How much of the caller's identity spans carry (ADR-0045). Default
   * `"clear"`: `typesys.identity.subject_id`. `"none"`: nothing.
   * Pseudonymous: `typesys.identity.pseudonym`, an HMAC-SHA-256 of the subject
   * id under `key` (at least 32 bytes). Audit rows keep the subject id either way.
   */
  telemetryIdentity?: TelemetryIdentity;
  /**
   * What `query` does with a read policy it can't plan exactly (ADR-0038).
   * Default `"post-filter"`: read with the best plan there is, decide every
   * object after the read. `"require-exact"`: refuse such a query.
   */
  rowSecurity?: RowSecurity;
  /**
   * A versioned set of guarantees the runtime checks at construction and
   * refuses to start without (ADR-0046), e.g. `HIGH_ASSURANCE_V1`. It
   * supplies the settings its guarantees fix and refuses weaker ones.
   */
  securityProfile?: SecurityProfile;
  /**
   * How computed properties reach adapters within one request (ADR-0062).
   * Default `"direct"`: every read they make goes to the adapter. `"coalesce"`:
   * an identical read is made once per request, and concurrent equality
   * lookups on one property become one `in` query, split back per value.
   * Computations receive the same answers either way.
   */
  computedReads?: "direct" | "coalesce";
  /**
   * Who may learn what the model is through `describeModel` (ADR-0068), and
   * so through every transport that describes it (HTTP, MCP, Studio).
   * Default `"open"`, the behavior before it existed. `"authenticated"`
   * refuses an anonymous caller; `"need-to-know"` also narrows the model to
   * what the caller could use. `HIGH_ASSURANCE_V2` requires `"need-to-know"`.
   */
  discovery?: Discovery;
  /**
   * Who may inspect the enforcement structure (ADR-0088): sources, mappings,
   * policies and markings. Omitted, nobody may. The policy is decided by the
   * runtime's engine like any other.
   */
  inspection?: InspectionOptions;
}

/** Every option a runtime understands — under a security profile, anything else is refused as a likely typo. */
const RUNTIME_OPTIONS: Readonly<Record<keyof SemanticRuntimeOptions, true>> = {
  cache: true,
  defaultCacheTtlMs: true,
  rateLimiter: true,
  maxConcurrency: true,
  queryLimits: true,
  resilience: true,
  classification: true,
  telemetryIdentity: true,
  rowSecurity: true,
  securityProfile: true,
  computedReads: true,
  discovery: true,
  inspection: true
};

const isFunction = (value: unknown): boolean => typeof value === "function";

/**
 * `options` under a high-assurance profile (ADR-0046, ADR-0068): the settings its guarantees
 * fix, supplied where omitted, and every violation collected — a weaker
 * setting is refused, never overridden.
 */
function underHighAssurance(options: SemanticRuntimeOptions, adapters: readonly Adapter[], policyEngine: PolicyEngine, profile: SecurityProfile): SemanticRuntimeOptions {
  const violations: string[] = [];
  // V2 adds one guarantee to V1's (ADR-0068): a caller learns only the part of the model they could use.
  const discovery = options.discovery ?? (profile === HIGH_ASSURANCE_V2 ? "need-to-know" : undefined);
  if (profile === HIGH_ASSURANCE_V2 && discovery !== "need-to-know") violations.push(`discovery must be "need-to-know", not ${JSON.stringify(discovery)}`);
  for (const key of Object.keys(options)) if (!Object.hasOwn(RUNTIME_OPTIONS, key)) violations.push(`unknown option "${key}"`);

  const rowSecurity = options.rowSecurity ?? "require-exact";
  if (rowSecurity !== "require-exact") violations.push(`rowSecurity must be "require-exact", not ${JSON.stringify(rowSecurity)}`);

  const telemetryIdentity = options.telemetryIdentity === undefined ? "none" : options.telemetryIdentity;
  if (telemetryIdentity === "clear") violations.push('telemetryIdentity must not be "clear"');
  else {
    try {
      telemetryOf(telemetryIdentity);
    } catch (err) {
      violations.push((err as Error).message);
    }
  }

  const components: [string, unknown][] = [...adapters.map((a): [string, unknown] => [`adapter "${String(a?.dataSourceId)}"`, a]), ...(options.cache ? [["the cache", options.cache] as [string, unknown]] : [])];
  for (const [label, component] of components) {
    const keys = (component as { keyManagement?: unknown } | undefined)?.keyManagement;
    if (keys !== undefined && keys !== "managed") violations.push(`${label} reports ${JSON.stringify(keys)} key management; keys must be managed`);
  }

  if (!isFunction((policyEngine as Partial<PolicyEngine> | undefined)?.evaluate)) violations.push("the policy engine has no evaluate()");
  for (const method of ["plan", "planAssurance"] as const) {
    const value = (policyEngine as unknown as Record<string, unknown> | undefined)?.[method];
    if (value !== undefined && !isFunction(value)) violations.push(`the policy engine's ${method} is not a function`);
  }

  const scheme = options.classification as Partial<ClassificationScheme> | undefined;
  if (scheme !== undefined) {
    if (typeof scheme?.name !== "string" || !isFunction(scheme.join) || !isFunction(scheme.decide)) violations.push("the classification scheme is malformed");
    else if (scheme.demonstration === true) violations.push(`the classification scheme "${scheme.name}" is a demonstration`);
  }

  const cache = options.cache as Partial<Cache> | undefined;
  if (cache !== undefined && (typeof cache?.confidential !== "boolean" || !["get", "set", "delete", "clear"].every((m) => isFunction((cache as Record<string, unknown>)[m])))) {
    violations.push("the cache is malformed");
  }

  if (violations.length > 0) throw new SecurityProfileError(profile.id, violations);
  return { ...options, rowSecurity, telemetryIdentity, ...(discovery ? { discovery } : {}) };
}

/**
 * The single boundary through which every consumer — a human application
 * or an AI agent over MCP — reads objects, navigates relationships,
 * queries, and invokes Actions. Policy and audit are enforced exactly
 * once, here, never re-implemented by a transport-specific layer (see
 * ADR-0009 and ADR-0012).
 */
export class SemanticRuntime {
  private readonly mappingResolver: MappingResolver;
  private readonly adapters: Map<string, Adapter>;
  private readonly inputValidator: InputValidator;
  private readonly cache: Cache;
  /** Resolved once (ADR-0036): only a cache declaring `confidential: true` may hold sensitive values. */
  private readonly cacheConfidential: boolean;
  private readonly defaultCacheTtlMs: number;
  private readonly rateLimiter: RateLimiter;
  private readonly maxConcurrency: number;
  private readonly resilience: AdapterResilience;
  private readonly classification: ClassificationScheme;
  private readonly rowSecurity: RowSecurity;
  /** The security profile in force, if any (ADR-0046). */
  private readonly profile: SecurityProfile | undefined;
  /** How identifiers and errors reach spans, per the telemetry identity policy (ADR-0045, ADR-0047). */
  private readonly telemetry: Telemetry;
  private readonly coalesceComputedReads: boolean;
  /** Who may learn what the model is (ADR-0068). */
  readonly discovery: Discovery;
  /** Who may inspect the enforcement structure (ADR-0088); undefined, nobody. */
  private readonly inspection: InspectionOptions | undefined;

  constructor(
    private readonly registry: SemanticRegistry,
    adapters: Adapter[],
    private readonly policyEngine: PolicyEngine,
    options: SemanticRuntimeOptions = {}
  ) {
    // Before this options object existed, the 4th argument was a positional `Cache`. Fail loudly
    // rather than silently treating a Cache as an (empty) options object and dropping it.
    if (typeof (options as { get?: unknown }).get === "function") {
      throw new TypeError("SemanticRuntime's 4th argument is now an options object: pass { cache } instead of a Cache");
    }
    if (options.securityProfile !== undefined) {
      const profile = SECURITY_PROFILES.get((options.securityProfile as Partial<SecurityProfile> | null)?.id as string);
      if (!profile) throw new SecurityProfileError(String((options.securityProfile as Partial<SecurityProfile> | null)?.id), ["this runtime implements no such security profile"]);
      this.profile = profile;
      options = underHighAssurance(options, adapters, policyEngine, profile);
    }
    this.cache = options.cache ?? new NoopCache();
    this.cacheConfidential = this.cache.confidential === true;
    this.defaultCacheTtlMs = options.defaultCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.rateLimiter = options.rateLimiter ?? new NoopRateLimiter();
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.inputValidator = new InputValidator(options.queryLimits);
    this.resilience = new AdapterResilience(options.resilience);
    this.classification = options.classification ?? DENY_MARKED_DATA;
    const rowSecurity = options.rowSecurity ?? "post-filter";
    if (rowSecurity !== "post-filter" && rowSecurity !== "require-exact") throw new TypeError(`rowSecurity must be "post-filter" or "require-exact"`);
    this.rowSecurity = rowSecurity;
    const computedReads = options.computedReads ?? "direct";
    if (computedReads !== "direct" && computedReads !== "coalesce") throw new TypeError(`computedReads must be "direct" or "coalesce"`);
    this.coalesceComputedReads = computedReads === "coalesce";
    const discovery = options.discovery ?? "open";
    if (!DISCOVERY_MODES.includes(discovery)) throw new TypeError(`discovery must be one of ${DISCOVERY_MODES.map((m) => `"${m}"`).join(", ")}`);
    this.discovery = discovery;
    const inspection = options.inspection;
    if (inspection !== undefined && (typeof inspection?.policy !== "string" || inspection.policy === "")) throw new TypeError("inspection.policy must name a policy");
    this.inspection = inspection === undefined ? undefined : { policy: inspection.policy };
    // Only an omitted option means the default: an explicit `null` is malformed, and "clear" is the least private choice.
    this.telemetry = telemetryOf(options.telemetryIdentity === undefined ? "clear" : options.telemetryIdentity);
    this.mappingResolver = new MappingResolver(registry);
    this.adapters = new Map(adapters.map((a) => [a.dataSourceId, a]));
  }

  /** `instrumentOperation`, recording errors as the telemetry policy allows (ADR-0047). */
  private instrument<T>(operationName: string, typeName: string, attributes: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T> {
    return instrumentOperation(operationName, typeName, attributes, fn, { redactErrors: this.telemetry.redactErrors });
  }

  /** The id of the security profile in force (ADR-0046), if any. */
  get securityProfile(): string | undefined {
    return this.profile?.id;
  }

  /**
   * Whether this runtime keeps raw identifiers out of telemetry — true unless
   * `telemetryIdentity` is `"clear"` (ADR-0047). Code that opens its own spans
   * around the runtime, like the MCP server, follows it.
   */
  get redactsTelemetryIdentifiers(): boolean {
    return this.telemetry.redactErrors;
  }

  /** The effective query bounds — what a transport should advertise (e.g. the MCP `query` tool's inputSchema). */
  get queryLimits(): QueryLimits {
    return this.inputValidator.limits;
  }

  /**
   * Returns the adapter gated by the current request's concurrency budget:
   * each method call takes a permit for the duration of that one call. The
   * same view is what computed properties and Actions get via
   * `ctx.getAdapter`, so their adapter calls count against the budget too.
   */
  private getAdapter(dataSourceId: string): Adapter {
    const adapter = this.adapters.get(dataSourceId);
    if (!adapter) throw new NotFoundError(`No adapter registered for data source "${dataSourceId}"`);
    const resilience = this.resilience;

    // `exit` runs the adapter call outside this request's budget, so an adapter that itself calls
    // back into a runtime starts a fresh budget instead of deadlocking on permits it can't get.
    // Resolved per call (not once), so it holds across resilience retries and after backoff sleeps.
    const underBudget = (invoke: () => Promise<unknown>): Promise<unknown> => {
      const budget = this.currentRequest()?.budget;
      return budget ? budget.run(() => requests.exit(invoke)) : invoke();
    };
    const explanation = this.currentRequest()?.explanation;
    // A source that fails is named on the failure, and while an explanation runs is a finding of its own (ADR-0089), timeouts and open breakers included.
    const traced = (call: Promise<unknown>): Promise<unknown> =>
      typeof (call as { catch?: unknown } | undefined)?.catch !== "function"
        ? call
        : call.catch((err: unknown) => {
            const failure = sourceFailure(err);
            if (failure && typeof err === "object" && err !== null && !FAILED_SOURCE.has(err)) FAILED_SOURCE.set(err, dataSourceId);
            if (failure && explanation) explanation.trace.push({ subjectId: "", action: "read", typeName: "", allow: false, control: "source", reason: failure, policy: dataSourceId });
            throw err;
          });

    return new Proxy(adapter, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...a: unknown[]) => Promise<unknown>;

        // No resilience policy: the exact pre-ADR-0026 path — budget only, original args, no signal.
        if (resilience.isNoop) {
          return (...args: unknown[]) => traced(underBudget(() => method.apply(target, args)));
        }

        // With a policy the breaker/timeout/retry wrap the budget, so backoff sleeps don't hold a
        // permit and each attempt takes a fresh one (ADR-0026). The deadline's signal goes in the
        // method's own `AdapterCallOptions` position, whatever the caller left out before it: a
        // computation calling `queryByType(type, filter)` must not have the signal taken as its `limit`.
        return (...args: unknown[]) => {
          const retryable = isRetryableAdapterCall(prop, args);
          return traced(resilience.run(dataSourceId, retryable, (signal) => {
            const callArgs = signal ? withSignal(prop, args, signal) : args;
            return underBudget(() => method.apply(target, callArgs));
          }));
        };
      }
    });
  }

  /**
   * Runs `fn` as one request: one concurrency budget of `maxConcurrency`
   * adapter calls, and one operation its audit rows name (ADR-0042). Nested
   * runtime calls (getRelationship's per-object getObject, include trees,
   * provenance recursion) find both already set and share them, so the cap
   * holds for the whole request rather than per fan-out level, where nested
   * levels would multiply it, and every row names what the caller asked for.
   */
  private withRequest<T>(operation: RuntimeOperation, fn: () => Promise<T>): Promise<T> {
    if (this.currentRequest()) return fn();
    return requests.run({ owner: this, budget: new Semaphore(this.maxConcurrency), operation }, fn);
  }

  /** This runtime's request in progress, if any; a request of another runtime instance is not this one's. */
  private currentRequest(): RequestContext | undefined {
    const store = requests.getStore();
    return store?.owner === this ? store : undefined;
  }

  private async checkRateLimit(identity: Identity): Promise<void> {
    // An investigation is charged to the investigator once, when it starts (ADR-0089), never to the subject it replays.
    const request = this.currentRequest();
    if (request?.explanation || request?.charged) return;
    if (!(await this.rateLimiter.tryAcquire(identity.subjectId))) {
      throw new RateLimitExceededError(`Rate limit exceeded for subject "${identity.subjectId}"`);
    }
  }

  private propertyCacheKey(dataSourceId: string, typeName: string, objectId: string): string {
    return `prop:${dataSourceId}:${typeName}:${objectId}`;
  }

  private relationshipCacheKey(dataSourceId: string, relationshipName: string, objectId: string): string {
    return `rel:${dataSourceId}:${relationshipName}:${objectId}`;
  }

  private computedCacheKey(typeName: string, objectId: string, propertyName: string): string {
    return `computed:${typeName}:${objectId}:${propertyName}`;
  }

  /** Records the cache outcome as both a metric and a `typesys.cache.hit` attribute on whichever span is active. */
  private noteCacheOutcome(outcome: "hit" | "miss" | "bypass"): void {
    recordCacheResult(outcome);
    annotateActiveSpan({ "typesys.cache.hit": outcome === "hit" });
  }

  /**
   * The fields the adapters behind `dataSourceIds` protect at rest (ADR-0036),
   * asked of each registered adapter itself. A declaration may be async — a
   * proxying decorator makes it so — but one that throws or answers anything
   * other than a list of names protects every field: fail closed.
   */
  private async protectedFields(typeName: string, dataSourceIds: readonly string[]): Promise<ProtectedFields> {
    const declared = await Promise.all(
      dataSourceIds.map(async (id): Promise<readonly string[] | "all"> => {
        const adapter = this.adapters.get(id);
        if (typeof adapter?.sensitiveFields !== "function") return [];
        try {
          const fields: unknown = await adapter.sensitiveFields(typeName);
          return Array.isArray(fields) && fields.every((f) => typeof f === "string") ? fields : "all";
        } catch {
          return "all";
        }
      })
    );
    if (declared.includes("all")) return { any: true, has: () => true };
    const fields = new Set((declared as (readonly string[])[]).flat());
    return { any: fields.size > 0, has: (field) => fields.has(field) };
  }

  /**
   * Whether a property bundle from `dataSourceId` may go to this runtime's
   * cache (ADR-0036). A bundle is everything that adapter returned for the
   * object, so outside a confidential cache it may only if nothing about the
   * Type is marked and the adapter protects none of its fields.
   */
  private async mayCacheBundle(typeDef: TypeDefinition, dataSourceId: string): Promise<boolean> {
    return this.cacheConfidential || (!isMarked(typeDef) && !(await this.protectedFields(typeDef.name, [dataSourceId])).any);
  }

  /** Whether a relationship's ref list may go to this runtime's cache (ADR-0036): outside a confidential cache, only if neither end nor the relationship is marked. */
  private async mayCacheRefs(typeDef: TypeDefinition, relDef: RelationshipDefinition): Promise<boolean> {
    if (this.cacheConfidential) return true;
    const target = await this.registry.getType(relDef.targetType);
    return target !== undefined && objectMarkings(typeDef).length === 0 && memberMarkings(typeDef, relDef.name).length === 0 && objectMarkings(target).length === 0;
  }

  /**
   * The computed properties whose values may not go to this runtime's cache
   * (ADR-0036): none, for a confidential cache; otherwise every one that is
   * sensitive or derives — through `dependsOn`, transitively — from a
   * sensitive value: of a marked Type or member, marked in its provenance,
   * or in a field an adapter protects.
   */
  private async uncacheableComputed(typeDef: TypeDefinition, resolved: ResolvedProperties): Promise<ReadonlySet<string>> {
    const computed = typeDef.computedProperties;
    if (this.cacheConfidential || !computed.some((cp) => cp.resolutionMode === "cached")) return new Set();
    if (objectMarkings(typeDef).length > 0) return new Set(computed.map((cp) => cp.name));

    const { base, overrides } = await this.mappingResolver.resolvePropertyMappings(typeDef.name);
    const protectedHere = await this.protectedFields(typeDef.name, [base, ...overrides].map((m) => m.dataSourceId));
    const sensitive = new Set<string>();
    for (const member of Object.keys(typeDef.schema["x-provenance"]?.properties ?? {})) {
      if (memberMarkings(typeDef, member).length > 0) sensitive.add(member);
    }
    for (const ref of resolved.provenance) if (valueMarkings([ref]).length > 0) sensitive.add(ref.propertyPath);
    const isSensitive = (name: string) => sensitive.has(name) || protectedHere.has(name);
    // Declaration order, the order they run in: a computed property's computed dependencies are already decided.
    for (const cp of computed) if (isSensitive(cp.name) || cp.dependsOn.some(isSensitive)) sensitive.add(cp.name);
    return new Set(computed.filter((cp) => sensitive.has(cp.name)).map((cp) => cp.name));
  }

  /** Cache is transparent here: same return shape whether it came from cache or the adapter (see ADR-0016). */
  private async resolveProperties(adapter: Adapter, mapping: Mapping, typeDef: TypeDefinition, objectId: string): Promise<ResolvedProperties> {
    const typeName = typeDef.name;
    if (mapping.resolutionMode !== "cached") return adapter.resolveProperties(typeName, objectId, []);
    if (!(await this.mayCacheBundle(typeDef, mapping.dataSourceId))) {
      this.noteCacheOutcome("bypass");
      return adapter.resolveProperties(typeName, objectId, []);
    }
    const key = this.propertyCacheKey(mapping.dataSourceId, typeName, objectId);
    const cached = await this.cache.get<ResolvedProperties>(key);
    if (cached) {
      this.noteCacheOutcome("hit");
      return cached;
    }
    this.noteCacheOutcome("miss");
    const resolved = await adapter.resolveProperties(typeName, objectId, []);
    // A value marked in its own provenance is sensitive too: read, but not stored outside a confidential cache.
    if (this.cacheConfidential || valueMarkings(resolved.provenance).length === 0) {
      await this.cache.set(key, resolved, mapping.cacheTtlMs ?? this.defaultCacheTtlMs);
    }
    return resolved;
  }

  /**
   * Merges a Type's base property bundle with zero-or-more per-property
   * overrides from other DataSources (ADR-0023) — e.g. most of an Aircraft
   * comes from a repository, but `warrantyStatus` comes from a separate
   * warranty system. An override's value (and provenance) replaces the
   * base's for that one field; a base value with no override is untouched.
   * Returns `base` unchanged, with zero adapter calls, when there are no
   * overrides — every Type that doesn't use this feature pays nothing for it.
   */
  private async mergeOverrides(
    typeDef: TypeDefinition,
    objectId: string,
    base: ResolvedProperties,
    overrides: Mapping[]
  ): Promise<ResolvedProperties> {
    if (overrides.length === 0) return base;

    const results = await mapWithConcurrency(overrides, this.maxConcurrency, async (mapping) => ({
      mapping,
      resolved: await this.resolveProperties(this.getAdapter(mapping.dataSourceId), mapping, typeDef, objectId)
    }));

    const values = { ...base.values };
    const provenance = [...base.provenance];
    for (const { mapping, resolved } of results) {
      // The override system may have nothing for this object — keep whatever the base had (or nothing).
      if (!(mapping.targetName in resolved.values)) continue;
      values[mapping.targetName] = resolved.values[mapping.targetName];

      const overrideProvenance = resolved.provenance.find((p) => p.propertyPath === mapping.targetName);
      if (!overrideProvenance) continue;
      const existingIndex = provenance.findIndex((p) => p.propertyPath === mapping.targetName);
      if (existingIndex >= 0) provenance[existingIndex] = overrideProvenance;
      else provenance.push(overrideProvenance);
    }
    return { values, provenance };
  }

  /** The base bundle plus any per-property overrides, merged (ADR-0023). What `getObject` and `query` both resolve properties through. */
  private async resolveObjectProperties(typeDef: TypeDefinition, objectId: string): Promise<ResolvedProperties> {
    const { base, overrides } = await this.mappingResolver.resolvePropertyMappings(typeDef.name);
    const baseResolved = await this.resolveProperties(this.getAdapter(base.dataSourceId), base, typeDef, objectId);
    return this.mergeOverrides(typeDef, objectId, baseResolved, overrides);
  }

  private async resolveRelationship(adapter: Adapter, typeDef: TypeDefinition, relDef: RelationshipDefinition, objectId: string): Promise<RelatedRef[]> {
    if (relDef.resolutionMode !== "cached") return adapter.resolveRelationship(relDef, objectId);
    if (!(await this.mayCacheRefs(typeDef, relDef))) {
      this.noteCacheOutcome("bypass");
      return adapter.resolveRelationship(relDef, objectId);
    }
    const key = this.relationshipCacheKey(relDef.resolution.dataSourceId, relDef.name, objectId);
    const cached = await this.cache.get<RelatedRef[]>(key);
    if (cached) {
      this.noteCacheOutcome("hit");
      return cached;
    }
    this.noteCacheOutcome("miss");
    const refs = await adapter.resolveRelationship(relDef, objectId);
    await this.cache.set(key, refs, relDef.cacheTtlMs ?? this.defaultCacheTtlMs);
    return refs;
  }

  private async resolveComputed(
    cp: ComputedPropertyDefinition,
    typeName: string,
    objectId: string,
    ctx: ComputeContext,
    cacheable: boolean
  ): Promise<unknown> {
    if (cp.resolutionMode !== "cached") return cp.compute(ctx);
    if (!cacheable) {
      this.noteCacheOutcome("bypass");
      return cp.compute(ctx);
    }
    const key = this.computedCacheKey(typeName, objectId, cp.name);
    const cached = await this.cache.get(key);
    if (cached !== undefined) {
      this.noteCacheOutcome("hit");
      return cached;
    }
    this.noteCacheOutcome("miss");
    const value = await cp.compute(ctx);
    await this.cache.set(key, value, cp.cacheTtlMs ?? this.defaultCacheTtlMs);
    return value;
  }

  /**
   * Clears every cache entry that exists about one object — its property
   * bundle, every relationship's cached ref list, every computed
   * property's cached value. A manual escape hatch (ADR-0016): call this
   * wherever your code knows it just wrote fresh data for this object,
   * rather than waiting out `cacheTtlMs`.
   */
  async invalidateObject(typeName: string, objectId: string): Promise<void> {
    const typeDef = await this.registry.getType(typeName);
    if (!typeDef) return;

    // Every property mapping — the wildcard base AND any per-property overrides
    // (ADR-0023) — since each can be independently cached under its own dataSourceId.
    const mappings = await this.registry.listMappings(typeName);
    for (const propertyMapping of mappings.filter((m) => m.target === "property")) {
      await this.cache.delete(this.propertyCacheKey(propertyMapping.dataSourceId, typeName, objectId));
    }
    for (const rel of typeDef.relationships) {
      await this.cache.delete(this.relationshipCacheKey(rel.resolution.dataSourceId, rel.name, objectId));
    }
    for (const cp of typeDef.computedProperties) {
      await this.cache.delete(this.computedCacheKey(typeName, objectId, cp.name));
    }
  }

  /** The stored properties a Type declares, inherited and from traits included, kept per definition. */
  private async declaredProperties(typeDef: TypeDefinition): Promise<ReadonlySet<string>> {
    let declared = DECLARED.get(typeDef);
    if (!declared) {
      declared = new Set(Object.keys((await composedProperties(this.registry, typeDef)).properties));
      DECLARED.set(typeDef, declared);
    }
    return declared;
  }

  private async requireType(typeName: string): Promise<TypeDefinition> {
    const typeDef = await this.registry.getType(typeName);
    if (!typeDef) throw new NotFoundError(`Unknown type "${typeName}"`);
    return typeDef;
  }

  /**
   * Asks the policy engine, deny-biased (ADR-0030): only an explicit
   * `allow: true` allows. An engine that throws, rejects, or answers with a
   * malformed decision denies — with a reason naming the policy but not the
   * error, whose message could quote an attribute value. It does not audit:
   * every decision goes through `evaluate`, which does.
   */
  private async decide(request: PolicyRequest): Promise<PolicyDecision> {
    const { person, audience } = principalsOf(request.subject);
    if (!audience) return this.decideFor(request);
    // Both must allow (ADR-0067): the person may read it, and it may be released to where it is going.
    const [forPerson, forAudience] = await Promise.all([this.decideFor({ ...request, subject: person }), this.decideFor({ ...request, subject: audience })]);
    const faults = [...(forPerson.faults ?? []), ...(forAudience.faults ?? [])];
    if (!forPerson.allow) return { ...forPerson, ...(faults.length ? { faults } : {}) };
    if (!forAudience.allow) return { allow: false, reason: `Not releasable to ${audience.subjectId}: ${forAudience.reason ?? "not allowed"}`, ...(faults.length ? { faults } : {}), [REFUSED_BY_AUDIENCE]: true } as PolicyDecision;
    return { ...forPerson, ...(faults.length ? { faults } : {}) };
  }

  private async decideFor(request: PolicyRequest): Promise<PolicyDecision> {
    let decision: PolicyDecision | undefined;
    try {
      decision = await this.policyEngine.evaluate(request);
    } catch {
      return { allow: false, reason: `Policy "${request.policyName}" failed to evaluate (fail closed)`, faults: [`policy ${request.policyName} failed to evaluate`] };
    }
    const bounded = boundedFaults(decision?.faults);
    const faults = this.profile ? enumeratedFaults(bounded) : bounded;
    if (decision?.allow === true) {
      const allowed: PolicyDecision = { ...decision };
      delete allowed.faults;
      return faults.length > 0 ? { ...allowed, faults } : allowed;
    }
    return {
      allow: false,
      reason: typeof decision?.reason === "string" ? decision.reason : `Policy "${request.policyName}" did not allow (fail closed)`,
      ...(faults.length > 0 ? { faults } : {})
    };
  }

  /** Records one decision. The row names what was decided about, never `resource.attributes`. */
  private async audit(
    identity: Identity,
    action: "read" | "invoke",
    resource: PolicyResource,
    decision: PolicyDecision,
    details?: Record<string, unknown>,
    traced?: { policy?: string; byAudience?: boolean }
  ): Promise<void> {
    recordPolicyDecision(decision.allow ? "allow" : "deny");
    const request = this.currentRequest();
    const operation = request?.operation;
    const explanation = request?.explanation;
    if (explanation) {
      explanation.trace.push({
        subjectId: identity.subjectId,
        action,
        typeName: resource.typeName,
        ...(resource.objectId !== undefined ? { objectId: resource.objectId } : {}),
        ...(resource.propertyPath !== undefined ? { propertyPath: resource.propertyPath } : {}),
        ...(resource.actionName !== undefined ? { actionName: resource.actionName } : {}),
        allow: decision.allow,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        ...(typeof details?.control === "string" ? { control: details.control } : traced?.policy ? { control: "policy" } : {}),
        ...(traced?.policy ? { policy: traced.policy } : {}),
        ...(traced?.byAudience ? { byAudience: true } : {}),
        ...(Array.isArray(details?.markings) ? { markings: details.markings as string[] } : {}),
        ...(Array.isArray(details?.inputs) ? { inputs: details.inputs as string[] } : {}),
        ...(Array.isArray(details?.released) ? { released: details.released as string[] } : {})
      });
      details = { ...details, explainedBy: explanation.investigator };
    }
    await this.registry.appendAuditEvent({
      id: ulid(),
      timestamp: new Date().toISOString(),
      subjectId: identity.subjectId,
      ...(operation ? { operation } : {}),
      action: resource.actionName ?? action,
      resource: { typeName: resource.typeName, objectId: resource.objectId, propertyPath: resource.propertyPath },
      decision: decision.allow ? "allow" : "deny",
      reason: decision.reason,
      ...(details || identity.audience ? { details: { ...details, ...(identity.audience ? { audience: identity.audience.id } : {}) } } : {})
    });
  }

  /** Decides and audits one policy check. */
  private async evaluate(identity: Identity, action: "read" | "invoke", policyName: string, resource: PolicyResource): Promise<PolicyDecision> {
    const decision = await this.decide({ subject: identity, action, policyName, resource });
    if (decision.faults) recordPolicyFaults(decision.faults.length);
    await this.audit(identity, action, resource, decision, decision.faults ? { faults: decision.faults } : undefined, { policy: policyName, byAudience: (decision as { [REFUSED_BY_AUDIENCE]?: true })[REFUSED_BY_AUDIENCE] === true });
    return decision;
  }

  private async requireAllowed(identity: Identity, action: "read" | "invoke", policyName: string, resource: PolicyResource): Promise<void> {
    const decision = await this.evaluate(identity, action, policyName, resource);
    if (!decision.allow) throw notAuthorized(action, resource, decision.reason, identity);
  }

  /**
   * What the scheme says about data under `markings` (ADR-0041): allowed only
   * if it allows their join *and* each marking on its own, so a join can add
   * restriction but never remove it. Unmarked data is allowed without asking
   * (ADR-0034). Deny-biased: a scheme that throws, or answers a join that
   * isn't a non-empty list of strings, or anything but `allow: true`, denies.
   * It does not audit: a decision about access goes through `clearedFor`.
   */
  private classify(
    identity: Identity,
    markings: readonly string[],
    resource: PolicyResource,
    action: "read" | "invoke"
  ): { allow: boolean; label: readonly string[]; reason?: string; byAudience?: true } {
    const { person, audience } = principalsOf(identity);
    const forPerson = this.classifyFor(person, markings, resource, action);
    if (!audience || !forPerson.allow) return forPerson;
    // Releasing marked data to an audience needs the audience cleared for it too (ADR-0067).
    const forAudience = this.classifyFor(audience, markings, resource, action);
    return forAudience.allow ? forPerson : { ...forAudience, reason: `not releasable to ${audience.subjectId}: ${forAudience.reason ?? "refused"}`, byAudience: true };
  }

  private classifyFor(
    identity: Identity,
    markings: readonly string[],
    resource: PolicyResource,
    action: "read" | "invoke"
  ): { allow: boolean; label: readonly string[]; reason?: string } {
    const marked = [...new Set(markings)];
    if (marked.length === 0) return { allow: true, label: [] };
    const context = { action, resource: { typeName: resource.typeName, objectId: resource.objectId, propertyPath: resource.propertyPath } };
    try {
      const answer: unknown = this.classification.join(marked);
      if (!isLabel(answer)) return { allow: false, label: marked, reason: "the scheme could not join the markings" };
      const label = answer;
      const joined = this.classification.decide({ subject: identity, markings: label, context });
      const refusal = typeof joined?.reason === "string" ? joined.reason : undefined;
      if (joined?.allow !== true) return { allow: false, label, ...(refusal ? { reason: refusal } : {}) };
      // Every marking on its own too — a join is the scheme's to write, and it must never be what opens data —
      // unless the label is that one marking, which was just decided.
      const decided = marked.length === 1 && label.length === 1 && label[0] === marked[0];
      for (const marking of decided ? [] : marked) {
        const each = this.classification.decide({ subject: identity, markings: [marking], context });
        if (each?.allow !== true) return { allow: false, label, reason: typeof each?.reason === "string" ? each.reason : `refused ${marking}` };
      }
      return { allow: true, label };
    } catch {
      return { allow: false, label: marked, reason: "the scheme failed to decide" };
    }
  }

  /**
   * Decides and audits one classification check (ADR-0032, ADR-0041). A
   * mandatory control beside the policy engine, never through it, so no
   * engine can relax it. Unmarked data — no markings — is no decision and
   * writes nothing (ADR-0034). The audit row keeps the inputs, the joined
   * label, and the scheme's reason; the caller only ever sees a generic one.
   */
  private async clearedFor(
    identity: Identity,
    markings: readonly string[],
    resource: PolicyResource,
    action: "read" | "invoke" = "read"
  ): Promise<boolean> {
    const marked = [...new Set(markings)];
    if (marked.length === 0) return true;
    const { allow, label, reason, byAudience } = this.classify(identity, marked, resource, action);
    const details = {
      control: "classification",
      scheme: this.classification.name,
      markings: marked,
      label,
      clearance: identity.clearance ?? null,
      ...(identity.audience ? { audienceClearance: identity.audience.clearance ?? null } : {}),
      ...(reason ? { reason } : {})
    };
    await this.audit(identity, action, resource, allow ? { allow } : { allow, reason: CLEARANCE_REASON }, details, byAudience ? { byAudience } : undefined);
    return allow;
  }

  private async requireCleared(
    identity: Identity,
    markings: readonly string[],
    resource: PolicyResource,
    action: "read" | "invoke" = "read"
  ): Promise<void> {
    if (!(await this.clearedFor(identity, markings, resource, action))) throw notAuthorized(action, resource, CLEARANCE_REASON, identity);
  }

  /**
   * What the Type's read policy admits for this subject (ADR-0038), fitted to
   * where the data is. Planning decides no access — every object read is
   * still decided after the read — so it isn't audited here; each path that
   * acts on a plan audits what it did with it.
   */
  private async planRead(typeDef: TypeDefinition, identity: Identity): Promise<AuthorizationPlan> {
    const plan = await this.askPlanner({ subject: identity, action: "read", policyName: objectPolicyOf(typeDef), resource: { typeName: typeDef.name } });
    const planned = plan.kind === "predicate" ? await this.fitPlan(typeDef, plan) : plan;
    annotateActiveSpan({
      "typesys.authz.plan.kind": planned.kind,
      "typesys.authz.plan.exact": isExact(planned),
      "typesys.authz.plan.limitations": limitationsOf(planned).map((l) => l.code).join(",")
    });
    return planned;
  }

  /** How far the engine vouches for its plan for this subject (ADR-0046); anything but a clear `"structural"` is unverified. */
  private async planAssurance(typeDef: TypeDefinition, identity: Identity): Promise<PlanAssurance> {
    const { person, audience } = principalsOf(identity);
    if (audience) {
      const both = await Promise.all([this.planAssurance(typeDef, person), this.planAssurance(typeDef, audience)]);
      return both.every((a) => a === "structural") ? "structural" : "unverified";
    }
    if (typeof this.policyEngine.planAssurance !== "function") return "unverified";
    try {
      const answer = await this.policyEngine.planAssurance({ subject: identity, action: "read", policyName: objectPolicyOf(typeDef), resource: { typeName: typeDef.name } });
      return answer === "structural" ? "structural" : "unverified";
    } catch {
      return "unverified";
    }
  }

  /**
   * The engine's plan, checked. An engine without a planner plans `unknown`;
   * one that throws or returns anything malformed — or claims an exactness
   * its limitations contradict — is a planner defect, and plans `unknown`
   * too: sound, and never exact, so `require-exact` refuses it.
   */
  private async askPlanner(request: PolicyRequest): Promise<AuthorizationPlan> {
    const { person, audience } = principalsOf(request.subject);
    if (audience) {
      // What both may read: the conjunction of their plans, sound because each is (ADR-0067).
      return allPlans(await Promise.all([this.askPlanner({ ...request, subject: person }), this.askPlanner({ ...request, subject: audience })]));
    }
    if (typeof this.policyEngine.plan !== "function") return unknownPlan([{ code: "engine-cannot-plan" }]);
    let returned: unknown;
    try {
      returned = await this.policyEngine.plan(request);
    } catch {
      returned = undefined;
    }
    const plan = checkPlan(returned);
    if (plan) return plan;
    recordPlanDefect("planner-failed");
    return unknownPlan([{ code: "planner-failed", policyName: request.policyName }]);
  }

  /**
   * A predicate plan fitted to the adapter that lists the Type (ADR-0038),
   * which filters on its own stored values — exactly what the policy decides
   * on, except for an attribute that comes from an override source
   * (ADR-0023) or one the adapter protects at rest (ADR-0036). Such an atom
   * becomes `true`, with the reason: replaced, never dropped, since dropping
   * a disjunct would admit less. The plan's own limitations carry over.
   */
  private async fitPlan(typeDef: TypeDefinition, plan: AuthorizationPlan & { kind: "predicate" }): Promise<AuthorizationPlan> {
    const { base, overrides } = await this.mappingResolver.resolvePropertyMappings(typeDef.name);
    const crossSource = new Set(overrides.map((m) => m.targetName));
    const protectedHere = await this.protectedFields(typeDef.name, [base.dataSourceId]);
    const filterable = await this.filterableAttributes(typeDef.name, base.dataSourceId, predicateAttributes(plan.predicate), protectedHere);
    const fitted = refitPredicate(plan.predicate, (atom) =>
      crossSource.has(atom.attribute)
        ? unknownPlan([{ code: "cross-source-attribute", attribute: atom.attribute }])
        : filterable.has(atom.attribute)
          ? predicatePlan(atom)
          : unknownPlan([protectedHere.has(atom.attribute) ? { code: "protected-attribute", attribute: atom.attribute } : { code: "unfilterable-attribute", attribute: atom.attribute }])
    );
    return plan.exact ? fitted : allPlans([fitted, unknownPlan(plan.limitations)]);
  }

  /**
   * The attributes the adapter listing the Type can filter by equality in its
   * store (ADR-0040): those it says it can, through `canFilter` — asked of the
   * registered adapter itself, possibly async, and only an answer of `true`
   * counts — or, for an adapter that doesn't say, every one it doesn't
   * protect at rest.
   */
  private async filterableAttributes(typeName: string, dataSourceId: string, attributes: ReadonlySet<string>, protectedHere: ProtectedFields): Promise<Set<string>> {
    const adapter = this.adapters.get(dataSourceId);
    const answers = await Promise.all(
      [...attributes].map(async (attribute) => {
        if (typeof adapter?.canFilter !== "function") return [attribute, !protectedHere.has(attribute)] as const;
        try {
          return [attribute, (await adapter.canFilter(typeName, attribute, "eq")) === true] as const;
        } catch {
          return [attribute, false] as const;
        }
      })
    );
    return new Set(answers.filter(([, can]) => can).map(([attribute]) => attribute));
  }

  /**
   * An object the post-read check denied although an exact plan admitted it
   * (ADR-0038): the planner was wrong. Audited as its own deny row and
   * counted; under `require-exact` it fails the query.
   */
  private async planDefect(identity: Identity, resource: PolicyResource, plan: AuthorizationPlan): Promise<void> {
    recordPlanDefect("admitted-denied");
    const reason = "An exact authorization plan admitted an object the policy denies";
    await this.audit(identity, "read", resource, { allow: false, reason }, { control: "row-plan", defect: "admitted-denied", ...planSummary(plan) });
    if (this.rowSecurity === "require-exact") throw new AuthorizationPlanError(`Refused under rowSecurity "require-exact": ${reason.toLowerCase()} (${resource.typeName})`);
  }

  /** The markings of every Type an Action applies to — its result is data of those Types (ADR-0032). */
  private async actionMarkings(action: ActionDefinition): Promise<string[]> {
    const typeDefs = await Promise.all(action.applicableTypes.map((t) => this.registry.getType(t)));
    return typeDefs.flatMap((typeDef) => (typeDef ? objectMarkings(typeDef) : []));
  }

  /**
   * The gates an Action invocation must pass, decided and audited: its
   * policy, then — only if that allows — the clearance its Types need
   * (ADR-0032). `invokeAction` enforces it and `listActions` reports it,
   * through this one audited path, so how an Action is listed and what
   * invoking it does can't drift apart.
   */
  private async authorizeInvoke(identity: Identity, action: ActionDefinition, typeName: string, instance?: { objectId: string; attributes: Attributes }): Promise<PolicyDecision> {
    const resource: PolicyResource = { typeName, actionName: action.name, ...(instance ?? {}) };
    const decision = await this.evaluate(identity, "invoke", action.authorizationPolicy, resource);
    if (!decision.allow) return decision;
    const cleared = await this.clearedFor(identity, await this.actionMarkings(action), resource, "invoke");
    return cleared ? decision : { allow: false, reason: CLEARANCE_REASON };
  }

  /**
   * The instance-level read check every path shares: the object's
   * classification first, before anything is read (ADR-0032), then its
   * stored values and the object policy decided on them (ADR-0030). Throws
   * `AuthorizationError` on a deny, after auditing it, and — only once the
   * caller is allowed — `ObjectNotFoundError` for an id no source holds
   * (ADR-0048): the decision comes first, so a denied caller is told nothing
   * about whether the id exists.
   */
  private async authorizeRead(
    typeDef: TypeDefinition,
    objectId: string,
    identity: Identity
  ): Promise<{ stored: ResolvedProperties; attributes: Attributes }> {
    await this.requireCleared(identity, objectMarkings(typeDef), { typeName: typeDef.name, objectId });
    // A source that refuses TypeSystem's own credential for this record (ADR-0072) is decided as a record it does not
    // have: the caller's policy first, so a denied caller learns nothing about whether the id exists (ADR-0048).
    let refused: SourceRefusedError | undefined;
    const stored = await this.resolveObjectProperties(typeDef, objectId).catch((err: unknown) => {
      if (!(err instanceof SourceRefusedError)) throw err;
      refused = err;
      return { values: {}, provenance: [] };
    });
    const attributes = snapshot(stored.values);
    await this.requireAllowed(identity, "read", objectPolicyOf(typeDef), { typeName: typeDef.name, objectId, attributes });
    if (refused) throw refused;
    if (Object.keys(stored.values).length === 0) throw new ObjectNotFoundError(typeDef.name, objectId);
    return { stored, attributes };
  }

  /**
   * A member (property or relationship) with its own marking or policy
   * narrows an already-authorized object read (ADR-0030, ADR-0032); one
   * without adds nothing.
   */
  private async requireMemberReadable(
    typeDef: TypeDefinition,
    member: string,
    objectId: string,
    attributes: Attributes,
    identity: Identity
  ): Promise<void> {
    await this.requireCleared(identity, memberMarkings(typeDef, member), { typeName: typeDef.name, objectId, propertyPath: member });
    const policyName = memberPolicyOf(typeDef, member);
    if (policyName) {
      await this.requireAllowed(identity, "read", policyName, { typeName: typeDef.name, objectId, propertyPath: member, attributes });
    }
  }

  /**
   * The properties classified out for this caller (ADR-0032): those whose
   * effective markings — the declared one, the value's provenance marking,
   * and for a computed property every marking of every dependency — aren't
   * all dominated by the caller's clearance. Decided over every resolved
   * value, so a derivation can't launder a marking.
   */
  private async classifiedOut(
    typeDef: TypeDefinition,
    objectId: string,
    identity: Identity,
    values: Record<string, unknown>,
    provenance: ProvenanceRef[],
    /** Decide these too, whether or not the object holds a value for them: an explanation's every declared value. */
    alsoDecide?: ReadonlySet<string>
  ): Promise<Set<string>> {
    const own = (name: string) => new Set([...memberMarkings(typeDef, name), ...valueMarkings(provenance.filter((p) => p.propertyPath === name))]);
    const effective = new Map([...new Set([...Object.keys(values), ...(alsoDecide ?? [])])].map((name) => [name, own(name)]));
    // Declaration order: a computed property's computed dependencies are already known.
    for (const cp of typeDef.computedProperties) {
      const markings = own(cp.name);
      for (const dep of cp.dependsOn) for (const m of effective.get(dep) ?? []) markings.add(m);
      effective.set(cp.name, markings);
    }

    const hidden = new Set<string>();
    for (const [name, markings] of effective) {
      if (!(name in values) && !alsoDecide) continue;
      if (!(await this.clearedFor(identity, [...markings], { typeName: typeDef.name, objectId, propertyPath: name }))) hidden.add(name);
    }
    return hidden;
  }

  /**
   * Runs computed properties, then redacts every property classified out
   * (ADR-0032) and every one whose own policy denies — decided on the
   * object's stored `attributes`. Returns the classified-out set too, for
   * `query`'s probe check.
   */
  private async finalizeValues(
    typeDef: TypeDefinition,
    objectId: string,
    identity: Identity,
    resolved: ResolvedProperties,
    attributes: Attributes
  ): Promise<{ values: Record<string, unknown>; provenance: ProvenanceRef[]; classified: ReadonlySet<string> }> {
    // Only what the model declares is read (ADR-0095): a column a source adds, or one the model drops, has no
    // policy, marking or contract, so returning it would hand every reader of the object what nobody governed.
    const declared = await this.declaredProperties(typeDef);
    const values: Record<string, unknown> = Object.fromEntries(Object.entries(resolved.values).filter(([name]) => declared.has(name)));
    const computedResults: Record<string, unknown> = {};

    const request = this.currentRequest();
    const reads = this.coalesceComputedReads && request ? (request.reads ??= new ReadCoalescer()) : undefined;
    // Each computed property reads only the inputs its own `dependsOn` names (ADR-0052): every gate below —
    // markings, policies, releases — is decided over `dependsOn`, so an undeclared read would bypass them all.
    // It reads as undefined, as a declared input this object has no value for does: the same for every object
    // and every caller.
    const contextFor = (cp: ComputedPropertyDefinition): ComputeContext => ({
      identity,
      objectId,
      typeName: typeDef.name,
      getAdapter: (dataSourceId: string) => {
        // A declared list is lineage the inspection reports as authoritative (ADR-0088), so it is enforced.
        if (cp.reads && !cp.reads.includes(dataSourceId)) throw new TypeError(`Computed property "${cp.name}" on "${typeDef.name}" reads data source "${dataSourceId}", which its reads do not declare`);
        return reads ? reads.view(this.getAdapter(dataSourceId)) : this.getAdapter(dataSourceId);
      },
      getProperty: async (name: string) => {
        if (!cp.dependsOn.includes(name)) return undefined;
        if (name in values) return values[name];
        return computedResults[name];
      }
    });

    const uncacheable = await this.uncacheableComputed(typeDef, resolved);
    for (const cp of typeDef.computedProperties) {
      computedResults[cp.name] = await this.resolveComputed(cp, typeDef.name, objectId, contextFor(cp), !uncacheable.has(cp.name));
    }
    Object.assign(values, computedResults);

    // Classification first, over every value, before policies remove any (ADR-0032).
    // While an explanation runs, every declared value is decided whether or not this object holds one, so a
    // withheld value is explained as withheld either way: otherwise the explanation would say which objects have it.
    const explaining = this.currentRequest()?.explanation !== undefined;
    const classified = await this.classifiedOut(typeDef, objectId, identity, values, resolved.provenance, explaining ? declared : undefined);
    for (const name of classified) delete values[name];

    // Each member policy is decided at most once per object read, whether for its own value or for a derivation.
    const memberDecisions = new Map<string, Promise<boolean>>();
    const memberReadable = (member: string): Promise<boolean> => {
      const policyName = memberPolicyOf(typeDef, member);
      if (!policyName) return Promise.resolve(true);
      let decided = memberDecisions.get(member);
      if (!decided) {
        decided = this.evaluate(identity, "read", policyName, { typeName: typeDef.name, objectId, propertyPath: member, attributes }).then((d) => d.allow);
        memberDecisions.set(member, decided);
      }
      return decided;
    };

    const unreadable = new Set<string>();
    for (const propName of Object.keys(typeDef.schema["x-policy"]?.propertyPolicies ?? {})) {
      if (!(propName in values) && !explaining) continue;
      if (!(await memberReadable(propName))) {
        delete values[propName];
        unreadable.add(propName);
      }
    }

    // A derived value is readable only where every input it derives from is (ADR-0052), as markings already
    // propagate (ADR-0032): otherwise readinessStatus would disclose the maintenanceStatus it maps one to one.
    // Declaration order, so a computed input has already been decided. An input with a policy is decided even
    // when it has no value, since a derivation can disclose that absence too. A release lifts only the named
    // input's own policy: an input withheld because of its own withheld inputs passes those on, and they keep
    // blocking here unless this property releases them too.
    const withheldBy = new Map<string, readonly string[]>();
    for (const cp of typeDef.computedProperties) {
      const blocked = new Set<string>();
      for (const dep of cp.dependsOn) {
        if (unreadable.has(dep) || !(await memberReadable(dep))) blocked.add(dep);
        for (const upstream of withheldBy.get(dep) ?? []) blocked.add(upstream);
      }
      if (blocked.size === 0) continue;
      const released = [...blocked].filter((dep) => cp.releases?.includes(dep));
      const withheld = [...blocked].filter((dep) => !released.includes(dep));
      const resource = { typeName: typeDef.name, objectId, propertyPath: cp.name };
      if (withheld.length > 0) {
        unreadable.add(cp.name);
        withheldBy.set(cp.name, withheld);
        if (!(cp.name in values)) continue;
        delete values[cp.name];
        await this.audit(identity, "read", resource, { allow: false, reason: "Derived from a property the caller may not read" }, { control: "derivation", ...derivationInputs(cp, withheld) });
      } else if (cp.name in values) {
        // A release is a declared exception to the rule above, so every use of one is on the record.
        await this.audit(identity, "read", resource, { allow: true }, { control: "derivation", released });
      }
    }

    // A computed value's schema (ADR-0055) is checked only where the caller reads the value: refusing the whole
    // read over a value the caller can't see would disclose something about it, object by object.
    for (const cp of typeDef.computedProperties) {
      if (cp.name in values) this.inputValidator.validateComputedValue(typeDef, cp, values[cp.name]);
    }

    const provenance = resolved.provenance.filter((p) => p.propertyPath in values);
    return { values, provenance, classified };
  }

  async getObject(
    typeName: string,
    objectId: string,
    identity: Identity,
    opts: { includeProvenance?: boolean } = {}
  ): Promise<ResolvedObject> {
    return (await this.readObject(typeName, objectId, identity, opts)).object;
  }

  /**
   * `getObject`, keeping the attributes the read was authorized on. The
   * object policy is decided on this instance's stored values (ADR-0030);
   * only an authorized read runs computed properties and redaction.
   */
  private async readObject(
    typeName: string,
    objectId: string,
    identity: Identity,
    opts: { includeProvenance?: boolean } = {}
  ): Promise<AuthorizedRead> {
    return this.withRequest("getObject", () => this.instrument(
      "SemanticRuntime.getObject",
      typeName,
      { ...this.telemetry.object(typeName, objectId), ...this.telemetry.subject(identity) },
      async () => {
        await this.checkRateLimit(identity);
        const typeDef = await this.requireType(typeName);
        const { stored, attributes } = await this.authorizeRead(typeDef, objectId, identity);

        const { values, provenance } = await this.finalizeValues(typeDef, objectId, identity, stored, attributes);
        return { object: { typeName, objectId, values, ...(opts.includeProvenance ? { provenance } : {}) }, attributes };
      }
    ));
  }

  async getRelationship(
    typeName: string,
    objectId: string,
    relationshipName: string,
    identity: Identity
  ): Promise<ResolvedObject[]> {
    return (await this.readRelationship(typeName, objectId, relationshipName, identity)).map((r) => r.object);
  }

  /**
   * `getRelationship`, keeping each related object's attributes for nested
   * includes. A relationship is readable only on a readable source
   * (ADR-0030): pass `sourceAttributes` when the source was already
   * authorized earlier in this request (an include), so it isn't resolved
   * and decided twice; otherwise it is authorized here.
   */
  private async readRelationship(
    typeName: string,
    objectId: string,
    relationshipName: string,
    identity: Identity,
    sourceAttributes?: Attributes
  ): Promise<AuthorizedRead[]> {
    return this.withRequest("getRelationship", () => this.instrument(
      "SemanticRuntime.getRelationship",
      typeName,
      { ...this.telemetry.object(typeName, objectId), "typesys.relationship_name": relationshipName, ...this.telemetry.subject(identity) },
      async () => {
        await this.checkRateLimit(identity);
        const typeDef = await this.requireType(typeName);
        const resolvedName = this.registry.resolveAlias(typeDef, relationshipName);
        const relDef = typeDef.relationships.find((r) => r.name === resolvedName);
        if (!relDef) throw new NotFoundError(`Unknown relationship "${relationshipName}" on type "${typeName}"`);

        const attributes = sourceAttributes ?? (await this.authorizeRead(typeDef, objectId, identity)).attributes;
        await this.requireMemberReadable(typeDef, relDef.name, objectId, attributes, identity);

        const adapter = this.getAdapter(relDef.resolution.dataSourceId);
        const relatedRefs = await this.resolveRelationship(adapter, typeDef, relDef, objectId);
        // Bound the *count* of the fan-out: a one-to-many with more related objects than
        // maxRelatedPerObject (ADR-0028) is truncated, the count-analogue of the maxConcurrency
        // bound on its concurrency (ADR-0019). The adapter's returned order is preserved.
        const bounded = relatedRefs.slice(0, this.queryLimits.maxRelatedPerObject);

        // Fan out concurrently, not one sequential round trip per related object — the classic
        // N+1 pattern for a one-to-many relationship. Bounded by maxConcurrency (ADR-0019) rather
        // than a raw Promise.allSettled, and an unauthorized related object is silently omitted
        // (existing behavior) without aborting the rest of a partially-authorized batch. So is a
        // dangling reference — one to an object no source holds (ADR-0048) — but only when the
        // failure is for *that* reference, not a not-found raised while reading some other object.
        const settled = await mapWithConcurrencySettled(bounded, this.maxConcurrency, (ref) =>
          this.readObject(relDef.targetType, ref.objectId, identity)
        );

        const results: AuthorizedRead[] = [];
        settled.forEach((outcome, i) => {
          if (outcome.status === "fulfilled") {
            results.push(outcome.value);
            return;
          }
          const reason: unknown = outcome.reason;
          const dangling = reason instanceof ObjectNotFoundError && reason.typeName === relDef.targetType && reason.objectId === bounded[i]!.objectId;
          if (!(reason instanceof AuthorizationError) && !dangling) throw reason;
        });
        return results;
      }
    ));
  }

  /**
   * `input` is validated against `semanticQuerySchema` and the runtime's
   * `QueryLimits` before anything else runs — callers (an MCP tool, an HTTP
   * body) routinely hand this unchecked JSON. An omitted `limit` becomes
   * `queryLimits.defaultLimit`; follow `nextCursor` for further pages.
   */
  async query(input: SemanticQuery, identity: Identity): Promise<QueryResult<ResolvedObject>> {
    const claimedType = (input as { type?: unknown } | null | undefined)?.type;
    return this.withRequest("query", () => this.instrument(
      "SemanticRuntime.query",
      typeof claimedType === "string" ? claimedType : "unknown",
      this.telemetry.subject(identity),
      async () => {
        await this.checkRateLimit(identity);
        const q = this.inputValidator.validateQuery(input);
        annotateActiveSpan({ "typesys.query.limit": q.limit });
        const typeDef = await this.requireType(q.type);
        // A classified Type is decided before the adapter runs: an uncleared caller is refused, and nothing of
        // the Type is read on their behalf (ADR-0032). The refusal is the same for every possible dataset, so it
        // says nothing about the data (ADR-0049). The object policy, by contrast, has no type-level gate: it is
        // decided per returned item, below (ADR-0030).
        await this.requireCleared(identity, objectMarkings(typeDef), { typeName: q.type });
        // A condition on a computed property can't run in the adapter, which has only stored values; it runs here
        // instead, on each object's finalized, caller-visible values (ADR-0054).
        const split = this.splitQueryFilter(typeDef, q.filter);
        if (q.filter) await this.requireReadableProperties(typeDef, filterProperties(q.filter), identity);
        if (q.sort) {
          this.rejectComputedSortProperties(typeDef, q.sort);
          await this.requireReadableProperties(typeDef, q.sort.map((s) => s.property), identity);
        }
        // `search` desugars to an `icontains` OR-filter over resolved, readable, non-computed
        // properties, AND-combined with any explicit filter (ADR-0027).
        const effectiveFilter = await this.resolveSearchFilter(typeDef, split.pushdown, q.search, identity);
        if (!split.residual && isScanCursor(q.cursor)) throw new InvalidInputError("Invalid query: this cursor belongs to a query filtered on computed properties");

        // The read policy as a filter the adapter applies before it reads (ADR-0038). A sound
        // over-approximation: whatever it excludes, the policy would have denied. Every object it admits
        // is still decided below.
        const plan = await this.planRead(typeDef, identity);
        const typeResource = { typeName: q.type };
        if (this.rowSecurity === "require-exact" && !isExact(plan)) {
          const codes = limitationsOf(plan).map((l) => l.code).join(", ");
          const message = `Refused under rowSecurity "require-exact": policy "${objectPolicyOf(typeDef)}" has no exact plan for this subject (${codes})`;
          await this.audit(identity, "read", typeResource, { allow: false, reason: message }, { control: "row-plan", ...planSummary(plan) }, { policy: objectPolicyOf(typeDef) });
          throw new AuthorizationPlanError(message);
        }
        // The policy admits no object of this Type for this subject, whatever the store holds (ADR-0038), so the
        // query is refused rather than answered with an empty page: a denial that depends on the data stays a
        // silent page, because an error there would reveal that hidden rows exist (ADR-0049).
        if (plan.kind === "never") {
          const reason = "No object of this Type is readable by this subject";
          await this.audit(identity, "read", typeResource, { allow: false, reason }, { control: "row-plan", ...planSummary(plan) }, { policy: objectPolicyOf(typeDef) });
          throw notAuthorized("read", typeResource, reason, identity);
        }
        // A predicate excludes objects without deciding them one by one, so the query records it once.
        if (plan.kind === "predicate") await this.audit(identity, "read", typeResource, { allow: true }, { control: "row-plan", ...planSummary(plan) });
        const plannedFilter: QueryFilter | undefined =
          plan.kind !== "predicate" ? effectiveFilter : effectiveFilter ? { and: [effectiveFilter, predicateToFilter(plan.predicate)] } : predicateToFilter(plan.predicate);

        // Listing/filtering/pagination is inherently single-source — only the base
        // mapping's adapter can answer "which objects match", so overrides (ADR-0023)
        // are merged per item below, not folded into this call.
        const { base, overrides } = await this.mappingResolver.resolvePropertyMappings(q.type);
        const adapter = this.getAdapter(base.dataSourceId);

        // Every item, and every `include` within an item, is independent — resolve the
        // whole O(items x includes) fan-out concurrently rather than one sequential
        // round trip at a time (the same N+1 pattern fixed in getRelationship above,
        // multiplied across a whole result page), bounded by maxConcurrency (ADR-0019)
        // so a large `limit` can't open unbounded concurrent adapter calls.
        const objectPolicy = objectPolicyOf(typeDef);
        const probed = new Set([
          ...(effectiveFilter ? filterProperties(effectiveFilter) : []),
          ...(split.residual ? filterProperties(split.residual) : []),
          ...(q.sort ?? []).map((s) => s.property)
        ]);
        const readPage = (page: AdapterQueryResult["items"]) => mapWithConcurrency(page, this.maxConcurrency, async (item) => {
          const stored = await this.mergeOverrides(typeDef, item.objectId, { values: item.values, provenance: item.provenance }, overrides);
          const attributes = snapshot(stored.values);
          // Decided on this item's own attributes (ADR-0030). A denied item is dropped silently (audited),
          // as getRelationship drops an unauthorized related object; it is never finalized or navigated.
          const decision = await this.evaluate(identity, "read", objectPolicy, { typeName: q.type, objectId: item.objectId, attributes });
          if (!decision.allow) {
            if (isExact(plan) && planAdmits(plan, attributes)) await this.planDefect(identity, { typeName: q.type, objectId: item.objectId }, plan);
            return undefined;
          }

          const { values, provenance, classified } = await this.finalizeValues(typeDef, item.objectId, identity, stored, attributes);
          // An item selected or ordered by a value its provenance classified out would reveal that value through
          // the selection itself, so it is dropped too (ADR-0032).
          if ([...probed].some((p) => classified.has(p))) return undefined;
          // The runtime part of the filter sees only what the caller may read: a withheld or redacted value is
          // absent, whatever it is, so the filter can't be used to probe it (ADR-0052, ADR-0054).
          if (split.residual && !matchesFilter(values, split.residual)) return undefined;
          // Projection trims the object's own properties, after redaction (ADR-0027); requested
          // includes are assigned afterward so they survive it.
          const projected = applyProjection(values, q.select);
          const resolved: ResolvedObject = {
            typeName: q.type,
            objectId: item.objectId,
            values: projected,
            ...(q.includeProvenance ? { provenance: q.select ? provenance.filter((p) => p.propertyPath in projected) : provenance } : {})
          };
          if (q.include) {
            await this.attachIncludes(resolved, attributes, q.include, identity);
          }
          return resolved;
        });

        if (!split.residual) {
          const result = await adapter.queryByType(q.type, plannedFilter, q.limit, q.cursor, q.sort);
          const items = await readPage(result.items);
          return { items: items.filter((item) => item !== undefined), nextCursor: result.nextCursor };
        }

        // Part of the filter runs here, so a page of the adapter's can yield fewer matches than asked for: read
        // pages until the page is full, the source is exhausted, or maxScanned rows were read (ADR-0054). The
        // cursor names the adapter page and how far into it this call got, so the next call resumes exactly there.
        const out: ResolvedObject[] = [];
        let position = decodeScanCursor(q.cursor);
        // The skip sizes the first adapter page, so a forged one would ask the source for any number of rows. A
        // cursor issued over an adapter that honours `limit` skips no further than one call may scan.
        if (position.skip > this.queryLimits.maxScanned) {
          throw new InvalidInputError("Invalid query: cursor was not issued for this query; pass the nextCursor this query returned");
        }
        let scanned = 0;
        for (;;) {
          // Only as many rows as could still be returned: rows past the limit would be read, decided and audited
          // for nothing, then read again by the next call.
          const pageSize = position.skip + Math.min(q.limit - out.length, this.queryLimits.maxScanned - scanned);
          const page = await adapter.queryByType(q.type, plannedFilter, pageSize, position.cursor, q.sort);
          const rows = page.items.slice(position.skip);
          const resolved = await readPage(rows);
          for (let i = 0; i < rows.length; i++) {
            scanned++;
            const item = resolved[i];
            if (item) out.push(item);
            const consumed = position.skip + i + 1;
            if (out.length === q.limit || scanned >= this.queryLimits.maxScanned) {
              const rest = consumed < page.items.length ? encodeScanCursor({ ...(position.cursor !== undefined ? { cursor: position.cursor } : {}), skip: consumed }) : page.nextCursor !== undefined ? encodeScanCursor({ cursor: page.nextCursor, skip: 0 }) : undefined;
              return { items: out, ...(rest ? { nextCursor: rest } : {}) };
            }
          }
          if (page.nextCursor === undefined) return { items: out };
          position = { cursor: page.nextCursor, skip: 0 };
        }
      }
    ));
  }

  /**
   * Grouped aggregation over a Type (ADR-0027). Same one-boundary treatment
   * as `query`: rate limit, input validation, object policy, and a
   * fail-closed guard that neither grouping nor an aggregation may reference a
   * property the caller can't read (which would leak it through a count or an
   * average) or a computed property (which doesn't exist at adapter time). The
   * work is pushed to the adapter's optional `aggregate`; a data source whose
   * adapter can't aggregate is a clear `AggregationNotSupportedError`, never a
   * silent pull-everything-and-count-in-the-runtime.
   */
  async aggregate(input: SemanticAggregateQuery, identity: Identity): Promise<AggregateResult> {
    const claimedType = (input as { type?: unknown } | null | undefined)?.type;
    return this.withRequest("aggregate", () => this.instrument(
      "SemanticRuntime.aggregate",
      typeof claimedType === "string" ? claimedType : "unknown",
      this.telemetry.subject(identity),
      async () => {
        await this.checkRateLimit(identity);
        const q = this.inputValidator.validateAggregateQuery(input);
        const typeDef = await this.requireType(q.type);
        // A type-level request — the adapter aggregates every row, so a rule that depends on an
        // instance's attributes can't allow it (ADR-0030) — unless the policy has an exact plan: then
        // the adapter aggregates exactly the rows this subject may read (ADR-0038). Anything less than
        // exact still fails closed: there is no post-read check on a sum.
        await this.requireCleared(identity, objectMarkings(typeDef), { typeName: q.type });
        const typeResource = { typeName: q.type };
        const typeLevel = await this.evaluate(identity, "read", objectPolicyOf(typeDef), typeResource);
        let rows = q.filter;
        if (!typeLevel.allow) {
          const plan = await this.planRead(typeDef, identity);
          if (!(plan.kind === "predicate" && plan.exact)) throw notAuthorized("read", typeResource, typeLevel.reason, identity);
          // An aggregate has no per-object check after it: under a profile, only a plan derived from the rule's
          // own structure may admit one (ADR-0046).
          if (this.profile && (await this.planAssurance(typeDef, identity)) !== "structural") {
            const reason = `Refused under ${this.profile.id}: the exact plan for policy "${objectPolicyOf(typeDef)}" was not derived structurally, and an aggregate has no per-object check`;
            await this.audit(identity, "read", typeResource, { allow: false, reason }, { control: "row-plan", assurance: "unverified", ...planSummary(plan) });
            throw new AuthorizationPlanError(reason);
          }
          await this.audit(identity, "read", typeResource, { allow: true }, { control: "row-plan", ...planSummary(plan) });
          rows = rows ? { and: [rows, predicateToFilter(plan.predicate)] } : predicateToFilter(plan.predicate);
        }

        const referenced = new Set<string>();
        if (q.filter) for (const p of filterProperties(q.filter)) referenced.add(p);
        for (const g of q.groupBy ?? []) referenced.add(g);
        for (const a of q.aggregations) if (a.property) referenced.add(a.property);
        this.rejectComputedAggregateProperties(typeDef, referenced);
        await this.requireReadableProperties(typeDef, referenced, identity);

        const { base } = await this.mappingResolver.resolvePropertyMappings(q.type);
        const adapter = this.getAdapter(base.dataSourceId);
        if (typeof adapter.aggregate !== "function") {
          throw new AggregationNotSupportedError(
            `Data source "${base.dataSourceId}" for type "${q.type}" does not support aggregation`
          );
        }
        return adapter.aggregate(rows === q.filter ? q : { ...q, filter: rows });
      }
    ));
  }

  /**
   * How `query` would authorize `input` for `identity` (ADR-0038): the read
   * policy's plan, fitted to where the data is, and the guarantees that
   * follow. Reads no data and decides no access. Runtime-only by design —
   * never an MCP tool — since a plan shows which attributes a policy tests
   * and the subject's own values; audited, with only the plan's kind,
   * exactness, and limitation codes.
   */
  async explainQuery(input: SemanticQuery, identity: Identity): Promise<QueryPlanReport> {
    const claimedType = (input as { type?: unknown } | null | undefined)?.type;
    return this.withRequest("explainQuery", () => this.instrument(
      "SemanticRuntime.explainQuery",
      typeof claimedType === "string" ? claimedType : "unknown",
      this.telemetry.subject(identity),
      async () => {
        await this.checkRateLimit(identity);
        // A plan describes the model (its sources, policies and members): refused or narrowed as describeModel is (ADR-0068).
        if (this.discovery !== "open" && isAnonymous(principalsOf(identity).person)) {
          const reason = "Describing the model needs an authenticated caller";
          await this.audit(identity, "read", { typeName: typeof claimedType === "string" ? claimedType : "unknown" }, { allow: false, reason }, { control: "explain", discovery: this.discovery });
          throw new AuthorizationError("Not authorized: explain a query", reason);
        }
        const q = this.inputValidator.validateQuery(input);
        const typeDef = await this.requireType(q.type);
        const needToKnow = this.discovery === "need-to-know";
        if (needToKnow && !(await this.discoveryGate(identity).typeReadable(typeDef))) {
          // Answered exactly as for a Type that does not exist; the audit row says which it was.
          await this.audit(identity, "read", { typeName: q.type }, { allow: false, reason: "Withheld by need-to-know discovery" }, { control: "explain", discovery: this.discovery });
          throw new NotFoundError(`Unknown type "${q.type}"`);
        }
        // The gates `query` decides before it plans, decided the same way: the plan describes the Type's members,
        // policies and sources, which a caller `query` would refuse has no business learning.
        await this.requireCleared(identity, objectMarkings(typeDef), { typeName: q.type });
        if (q.filter) await this.requireReadableProperties(typeDef, filterProperties(q.filter), identity);
        if (q.sort) {
          this.rejectComputedSortProperties(typeDef, q.sort);
          await this.requireReadableProperties(typeDef, q.sort.map((s) => s.property), identity);
        }
        const plan = await this.planRead(typeDef, identity);
        const computed = new Set(typeDef.computedProperties.map((c) => c.name));
        const searched = q.search ? (q.search.properties ?? Object.keys(typeDef.schema.properties ?? {}).filter((p) => !computed.has(p))) : [];
        const probes = [...new Set([...(q.filter ? filterProperties(q.filter) : []), ...(q.sort ?? []).map((s) => s.property), ...searched])];
        const exact = isExact(plan);
        const described = await this.describeExecution(typeDef, q, plan, identity, needToKnow ? await this.describedMembers(typeDef, identity) : undefined);
        // Which source holds a Type is enforcement structure, shown only to an inspector (ADR-0088).
        const execution = (await this.mayInspect(identity)) ? described : withheldSources(described);
        await this.audit(identity, "read", { typeName: q.type }, { allow: true }, { control: "row-plan", operation: "explainQuery", ...planSummary(plan) });
        return {
          typeName: q.type,
          policyName: objectPolicyOf(typeDef),
          securityProfile: this.profile?.id ?? null,
          rowSecurity: this.rowSecurity,
          plan,
          execution,
          probes,
          guarantees: {
            exact,
            paginationPrivate: exact && probes.length === 0,
            aggregationSafe: plan.kind === "always" || (plan.kind === "predicate" && plan.exact),
            postFilterRequired: !exact
          }
        };
      }
    ));
  }

  /**
   * Turns a `search` into an `icontains` OR-filter over resolved properties,
   * AND-combined with any explicit filter (ADR-0027). Property resolution
   * fails closed: an explicitly-named property that the caller can't read is
   * denied and a computed one is rejected; when properties are omitted, the
   * type's own readable, non-computed, non-policy-gated properties are used
   * (never a gated one, since search runs pre-redaction in the adapter).
   */
  private async resolveSearchFilter(
    typeDef: TypeDefinition,
    filter: QueryFilter | undefined,
    search: SearchSpec | undefined,
    identity: Identity
  ): Promise<QueryFilter | undefined> {
    if (!search) return filter;
    const props = await this.resolveSearchProperties(typeDef, search.properties, identity);
    if (props.length === 0) {
      throw new InvalidInputError(
        `Invalid query: no searchable properties on "${typeDef.name}"; name them explicitly in search.properties`
      );
    }
    const searchFilter: QueryFilter =
      props.length === 1
        ? { property: props[0]!, operator: "icontains", value: search.text }
        : { or: props.map((p) => ({ property: p, operator: "icontains", value: search.text })) };
    return filter ? { and: [filter, searchFilter] } : searchFilter;
  }

  private async resolveSearchProperties(
    typeDef: TypeDefinition,
    named: string[] | undefined,
    identity: Identity
  ): Promise<string[]> {
    const computed = new Set(typeDef.computedProperties.map((c) => c.name));
    if (named && named.length > 0) {
      const computedNamed = named.filter((p) => computed.has(p));
      if (computedNamed.length > 0) {
        throw new InvalidInputError(
          `Invalid query: cannot search computed ${computedNamed.length === 1 ? "property" : "properties"} ` +
            `${computedNamed.map((p) => `"${p}"`).join(", ")}`
        );
      }
      await this.requireReadableProperties(typeDef, named, identity);
      return named;
    }
    const gated = new Set(Object.keys(typeDef.schema["x-policy"]?.propertyPolicies ?? {}));
    const declared = Object.keys(typeDef.schema.properties ?? {});
    // Query planning, not an access decision, so not audited: a skipped field is never read or matched, and
    // every value the search does return is decided (and audited) in finalizeValues (ADR-0032).
    return declared.filter((p) => !computed.has(p) && !gated.has(p) && this.classify(identity, memberMarkings(typeDef, p), { typeName: typeDef.name, propertyPath: p }, "read").allow);
  }

  private rejectComputedAggregateProperties(typeDef: TypeDefinition, names: Set<string>): void {
    const computed = new Set(typeDef.computedProperties.map((c) => c.name));
    const used = [...names].filter((p) => computed.has(p));
    if (used.length > 0) {
      throw new InvalidInputError(
        `Invalid aggregate query: cannot group or aggregate "${typeDef.name}" on computed ` +
          `${used.length === 1 ? "property" : "properties"} ${used.map((p) => `"${p}"`).join(", ")}; ` +
          `computed values don't exist until after the adapter has run.`
      );
    }
  }

  /** The query's filter split into what the adapter runs and what runs here, on finalized values (ADR-0054). */
  private splitQueryFilter(typeDef: TypeDefinition, filter: QueryFilter | undefined) {
    const computed = new Set(typeDef.computedProperties.map((c) => c.name));
    return splitFilter(filter, (p) => computed.has(p));
  }

  /**
   * How `query` will run `q` (ADR-0054): the same filter split, sources and
   * steps `query` uses, described rather than executed. Includes are walked
   * from the registry, so an unknown relationship is reported here too.
   */
  /**
   * The members of `typeDef` need-to-know describes to this caller (ADR-0068), by `narrowModel`'s rule:
   * readable members, and computed values whose inputs are all described (or released) and readable.
   */
  private async describedMembers(typeDef: TypeDefinition, identity: Identity): Promise<ReadonlySet<string>> {
    const gate = this.discoveryGate(identity);
    const members = new Set<string>();
    for (const name of Object.keys(typeDef.schema.properties ?? {})) if (await gate.memberReadable(typeDef, name)) members.add(name);
    for (const rel of typeDef.relationships) if (await gate.memberReadable(typeDef, rel.name)) members.add(rel.name);
    for (const cp of typeDef.computedProperties) {
      const released = new Set(cp.releases ?? []);
      if (cp.dependsOn.every((d) => members.has(d) || released.has(d)) && (await gate.memberReadable(typeDef, cp.name))) members.add(cp.name);
    }
    return members;
  }

  private async describeExecution(
    typeDef: TypeDefinition,
    q: SemanticQuery & { limit: number },
    plan: AuthorizationPlan,
    identity: Identity,
    described?: ReadonlySet<string>
  ): Promise<ExecutionPlan> {
    // Under need-to-know the plan names only the members the caller is told of; the rest are still computed and redacted.
    const told = (member: string) => !described || described.has(member);
    const split = this.splitQueryFilter(typeDef, q.filter);
    const { base, overrides } = await this.mappingResolver.resolvePropertyMappings(typeDef.name);
    const notes: string[] = [];
    const steps: ExecutionStep[] = [{ op: "classification-gate", marked: objectMarkings(typeDef).length > 0 }];
    steps.push({
      op: "scan",
      dataSourceId: base.dataSourceId,
      ...(split.pushdown || q.search ? { pushdownFilter: await this.resolveSearchFilter(typeDef, split.pushdown, q.search, identity) } : {}),
      authorizationPredicate: plan.kind === "predicate",
      ...(q.sort ? { sort: q.sort } : {}),
      pageSize: q.limit
    });
    if (overrides.length > 0) steps.push({ op: "merge-overrides", dataSourceIds: [...new Set(overrides.map((o) => o.dataSourceId))], callsPerObject: overrides.length });
    steps.push({ op: "authorize-rows", policyName: objectPolicyOf(typeDef), decidedPerObject: true });
    const computedTold = typeDef.computedProperties.filter((c) => told(c.name));
    if (computedTold.length > 0) steps.push({ op: "compute", properties: computedTold.map((c) => ({ name: c.name, dependsOn: c.dependsOn.filter(told) })) });
    const memberPolicies = Object.keys(typeDef.schema["x-policy"]?.propertyPolicies ?? {}).filter(told);
    const marked = Object.keys(typeDef.schema["x-provenance"]?.properties ?? {}).filter((m) => memberMarkings(typeDef, m).length > 0 && told(m));
    if (memberPolicies.length > 0 || marked.length > 0 || typeDef.computedProperties.length > 0) steps.push({ op: "redact", memberPolicies, marked });
    if (split.residual) {
      steps.push({ op: "residual-filter", filter: split.residual, maxScanned: this.queryLimits.maxScanned });
      notes.push(
        `Part of the filter names computed properties, so it runs after each object is read: a page can come back short with a nextCursor, and one call reads at most ${this.queryLimits.maxScanned} rows.`
      );
    }
    if (q.select) steps.push({ op: "project", select: q.select });
    const walk = async (owner: TypeDefinition, includes: SemanticQuery["include"], depth: number): Promise<void> => {
      for (const inc of includes ?? []) {
        const relName = this.registry.resolveAlias(owner, inc.relationship);
        const rel = owner.relationships.find((r) => r.name === relName);
        if (!rel) throw new NotFoundError(`Unknown relationship "${inc.relationship}" on type "${owner.name}"`);
        // An include need-to-know withholds is not described, as one the caller isn't cleared for isn't.
        if (described && owner === typeDef && !described.has(rel.name)) continue;
        // An include the caller isn't cleared for — the relationship's own marking or its target Type's — returns
        // nothing of it, so the plan doesn't describe where it reads from either.
        const target = await this.registry.getType(rel.targetType);
        const markings = [...memberMarkings(owner, rel.name), ...(target ? objectMarkings(target) : [])];
        if (!(await this.clearedFor(identity, markings, { typeName: owner.name, propertyPath: rel.name }))) continue;
        steps.push({ op: "include", relationship: rel.name, targetType: rel.targetType, dataSourceId: rel.resolution.dataSourceId, depth, filtered: inc.filter !== undefined });
        if (target && inc.include) await walk(target, inc.include, depth + 1);
      }
    };
    await walk(typeDef, q.include, 1);
    if (!isExact(plan)) notes.push("The read policy has no exact plan for this caller, so rows are decided after they are read: pages can come back short.");
    if (typeDef.computedProperties.length > 0) {
      notes.push(`Each returned object runs ${typeDef.computedProperties.length} computed ${typeDef.computedProperties.length === 1 ? "property" : "properties"}, which may call other systems.`);
    }
    return { steps, adapterCallsPerObject: { overrides: overrides.length, computed: typeDef.computedProperties.length }, notes };
  }

  /**
   * The top-level sort runs in the adapter too, so — exactly like a filter —
   * it cannot order by a computed property, which doesn't exist until after
   * the adapter has returned its page. Reject it with a clear pointer (ADR-0027).
   */
  private rejectComputedSortProperties(typeDef: TypeDefinition, sort: SortKey[]): void {
    const computed = new Set(typeDef.computedProperties.map((c) => c.name));
    const used = sort.map((s) => s.property).filter((p) => computed.has(p));
    if (used.length > 0) {
      throw new InvalidInputError(
        `Invalid query: cannot sort "${typeDef.name}" on computed ${used.length === 1 ? "property" : "properties"} ` +
          `${used.map((p) => `"${p}"`).join(", ")}; computed values don't exist until after the adapter has sorted. ` +
          `Sort the results client-side instead.`
      );
    }
  }

  /**
   * A top-level filter or sort runs in the adapter, against raw values,
   * *before* property-level redaction. So filtering or ordering by a property
   * the caller can't read would still select or position objects by its
   * hidden value, and which objects come back — or in what order — would
   * reveal it. Reject such a query outright (audited as a deny) rather than
   * answer it. Checked per Type, not per object — a type-level request with
   * no attributes (ADR-0030) — so a policy that only allows some objects'
   * values denies the whole query, failing closed. A property marked above
   * the caller's clearance is refused the same way (ADR-0032).
   */
  private async requireReadableProperties(typeDef: TypeDefinition, propertyNames: Iterable<string>, identity: Identity): Promise<void> {
    const declared = await this.declaredProperties(typeDef);
    for (const property of propertyNames) {
      // A value the model does not declare is never read (ADR-0095), so it can't select or order objects either:
      // filtering on a column a source holds but nobody governed would disclose it one object at a time.
      if (!declared.has(property) && !typeDef.computedProperties.some((cp) => cp.name === property)) throw new InvalidInputError(`Invalid query: "${property}" is not a value of ${typeDef.name}`);
      await this.requireCleared(identity, memberMarkings(typeDef, property), { typeName: typeDef.name, propertyPath: property });
      const policyName = memberPolicyOf(typeDef, property);
      if (!policyName) continue;
      await this.requireAllowed(identity, "read", policyName, { typeName: typeDef.name, propertyPath: property });
    }
  }

  /**
   * Resolves one already-authorized object's `include` tree (ADR-0011), keyed
   * by relationship name. Each entry navigates through `readRelationship`
   * with the source's `attributes`, so relationship policy and per-object
   * authorization and redaction apply exactly as on a direct call; then the
   * entry's own `filter` runs against each related object's *visible*
   * values, and its nested `include` recurses from each survivor. Filtering
   * after redaction treats a property the caller can't read as absent, so
   * an include filter can never be used to probe a hidden value.
   */
  private async resolveIncludes(
    typeName: string,
    objectId: string,
    attributes: Attributes,
    includes: QueryInclude[],
    identity: Identity
  ): Promise<Record<string, ResolvedObject[]>> {
    const results = await mapWithConcurrency(includes, this.maxConcurrency, async (inc) => {
      const related = await this.readRelationship(typeName, objectId, inc.relationship, identity, attributes);
      const filtered = inc.filter ? related.filter((r) => matchesFilter(r.object.values, inc.filter)) : related;
      // Sort then limit the related set (ADR-0028), post-resolution — so an include sort may
      // reference computed properties (unlike a top-level sort) and both see already-redacted values.
      const sorted = inc.sort ? applySort(filtered, inc.sort, (r) => r.object.values) : filtered;
      const kept = inc.limit != null ? sorted.slice(0, inc.limit) : sorted;
      // Projection (ADR-0027) runs AFTER filter/sort/limit (which see full visible values) and
      // BEFORE nested includes are assigned, so those survive it.
      if (inc.select) {
        for (const r of kept) r.object.values = applyProjection(r.object.values, inc.select);
      }
      const nested = inc.include;
      if (nested && nested.length > 0) {
        await mapWithConcurrency(kept, this.maxConcurrency, async ({ object, attributes: relatedAttributes }) => {
          await this.attachIncludes(object, relatedAttributes, nested, identity).catch((err: unknown) => {
            // A failure the nested level did not absorb is its own (a required relationship there): no outer optional
            // relationship may report it as its source being unavailable.
            if (err !== null && typeof err === "object") NESTED_FAILURES.add(err);
            throw err;
          });
        });
      }
      return kept.map((r) => r.object);
    });
    return Object.fromEntries(includes.map((inc, i) => [inc.relationship, results[i]!]));
  }

  /**
   * Resolves `object`'s includes into its values. An include of an
   * `optional` relationship whose source fails (ADR-0072) is left out and
   * recorded in `object.unavailable`, never returned as `[]`; anything else
   * that fails, fails the read as before.
   */
  private async attachIncludes(object: ResolvedObject, attributes: Attributes, includes: QueryInclude[], identity: Identity): Promise<void> {
    const typeDef = await this.requireType(object.typeName);
    const relOf = (name: string) => typeDef.relationships.find((r) => r.name === this.registry.resolveAlias(typeDef, name));
    const settled = await mapWithConcurrency(includes, this.maxConcurrency, async (inc): Promise<{ values: Record<string, ResolvedObject[]> } | { missing: UnavailablePart }> => {
      try {
        return { values: await this.resolveIncludes(object.typeName, object.objectId, attributes, [inc], identity) };
      } catch (err) {
        const rel = relOf(inc.relationship);
        const nestedFailure = err !== null && typeof err === "object" && NESTED_FAILURES.has(err);
        const reason = rel?.optional && !nestedFailure ? sourceFailure(err) : undefined;
        if (!rel || !reason) throw err;
        const failed = typeof err === "object" && err !== null ? FAILED_SOURCE.get(err) : undefined;
        return { missing: { path: inc.relationship, dataSourceId: failed ?? rel.resolution.dataSourceId, reason, message: err instanceof Error ? err.message : String(err) } };
      }
    });
    const unavailable: UnavailablePart[] = [];
    for (const part of settled) {
      if ("values" in part) Object.assign(object.values, part.values);
      else unavailable.push(part.missing);
    }
    if (unavailable.length > 0) object.unavailable = [...(object.unavailable ?? []), ...unavailable];
  }

  async getProvenance(
    typeName: string,
    objectId: string,
    propertyPath: string,
    identity: Identity
  ): Promise<ProvenanceRef[]> {
    return this.readProvenance(typeName, objectId, propertyPath, identity);
  }

  /**
   * `getProvenance`. A property's provenance is readable only where its
   * value would be (ADR-0030): on a readable object, then narrowed by the
   * property's own policy. A computed property recurses into its
   * dependencies with the object already authorized (`source`), so each is
   * checked against its own policy without re-deciding the object.
   * `released` marks an input its dependant releases (ADR-0052): only that
   * input's own policy is lifted, and a denial of it leaves its provenance
   * out rather than refusing. Its markings and its own inputs are decided
   * as for any other input, so whatever withholds the value refuses here.
   */
  private async readProvenance(
    typeName: string,
    objectId: string,
    propertyPath: string,
    identity: Identity,
    source?: { typeDef: TypeDefinition; attributes: Attributes; released?: boolean }
  ): Promise<ProvenanceRef[]> {
    return this.withRequest("getProvenance", () => this.instrument(
      "SemanticRuntime.getProvenance",
      typeName,
      { ...this.telemetry.object(typeName, objectId), "typesys.property_path": propertyPath, ...this.telemetry.subject(identity) },
      async () => {
        await this.checkRateLimit(identity);
        const typeDef = source?.typeDef ?? (await this.requireType(typeName));
        const attributes = source?.attributes ?? (await this.authorizeRead(typeDef, objectId, identity)).attributes;
        let leftOut = false;
        if (source?.released) {
          await this.requireCleared(identity, memberMarkings(typeDef, propertyPath), { typeName, objectId, propertyPath });
          const policyName = memberPolicyOf(typeDef, propertyPath);
          if (policyName) leftOut = !(await this.evaluate(identity, "read", policyName, { typeName, objectId, propertyPath, attributes })).allow;
        } else {
          await this.requireMemberReadable(typeDef, propertyPath, objectId, attributes, identity);
        }

        const computed = typeDef.computedProperties.find((c) => c.name === propertyPath);
        if (computed) {
          // A released input (ADR-0052) lets the value through but never the input: where its own policy denies
          // the caller, its provenance is left out rather than refusing the whole answer. Any other unreadable
          // input refuses — a marking, or a released input's own unreleased input — as the value is withheld.
          const nested = await mapWithConcurrency(computed.dependsOn, this.maxConcurrency, (dep) =>
            this.readProvenance(typeName, objectId, dep, identity, { typeDef, attributes, released: computed.releases?.includes(dep) === true })
          );
          if (leftOut) return [];
          // A computation may also ask other systems through ctx.getAdapter (needsAttention asks the maintenance
          // system for open work orders): each system it consulted this time is named too, as a source of the value.
          const refs = nested.flat();
          const named = new Set(refs.map((r) => r.source.dataSourceId));
          for (const consulted of await this.consultedSources(typeDef, objectId, computed, identity)) {
            if (named.has(consulted.dataSourceId)) continue;
            named.add(consulted.dataSourceId);
            refs.push({ propertyPath, source: consulted, retrievedAt: new Date().toISOString() });
          }
          return refs;
        }

        const mapping = await this.mappingResolver.resolvePropertyMapping(typeName, propertyPath);
        const adapter = this.getAdapter(mapping.dataSourceId);
        const resolved = await adapter.resolveProperties(typeName, objectId, [propertyPath]);
        const refs = resolved.provenance.filter((p) => p.propertyPath === propertyPath);
        // The value's own marking, known only once it has been read (ADR-0032).
        await this.requireCleared(identity, valueMarkings(refs), { typeName, objectId, propertyPath });
        return leftOut ? [] : refs;
      }
    ));
  }

  /**
   * The systems `cp`'s computation reads through `ctx.getAdapter` for this
   * object, found by running it once more against the stored values with
   * each adapter it asks for recorded (computed inputs it depends on are
   * computed first, as a read computes them). Names only: what it read
   * there is not returned.
   */
  private async consultedSources(typeDef: TypeDefinition, objectId: string, cp: ComputedPropertyDefinition, identity: Identity): Promise<{ dataSourceId: string; system: string }[]> {
    const values: Record<string, unknown> = { ...(await this.resolveObjectProperties(typeDef, objectId)).values };
    const consulted = new Map<string, string>();
    const recording = (adapter: Adapter): Adapter =>
      new Proxy(adapter, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value !== "function" || !["resolveProperties", "queryByType", "resolveRelationship", "aggregate"].includes(String(prop))) return value;
          return async (...args: unknown[]) => {
            const result: unknown = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            const refs = provenanceIn(result);
            if (!consulted.has(target.dataSourceId) || refs.length > 0) consulted.set(target.dataSourceId, refs[0]?.source.system ?? consulted.get(target.dataSourceId) ?? target.dataSourceId);
            return result;
          };
        }
      });
    const contextFor = (c: ComputedPropertyDefinition, record: boolean): ComputeContext => ({
      identity,
      objectId,
      typeName: typeDef.name,
      getAdapter: (dataSourceId: string) => (record ? recording(this.getAdapter(dataSourceId)) : this.getAdapter(dataSourceId)),
      getProperty: async (name: string) => (c.dependsOn.includes(name) ? values[name] : undefined)
    });
    for (const c of typeDef.computedProperties) {
      if (c.name === cp.name) {
        await cp.compute(contextFor(cp, true));
        break;
      }
      if (cp.dependsOn.includes(c.name)) values[c.name] = await c.compute(contextFor(c, false));
    }
    return [...consulted].map(([dataSourceId, system]) => ({ dataSourceId, system }));
  }

  /**
   * The gate every invocation, preview and listing shares (ADR-0053). A
   * type-scoped Action is decided per Type, as before. An instance-scoped one
   * reads its target first, under the caller's read authorization — a target
   * the caller may not read refuses the Action, audited as that read's deny —
   * then decides the Action's policy on the target's stored attributes. An
   * input that names no target is decided per Type, so an attribute rule
   * denies it and the attempt is still audited.
   */
  private async gateAction(identity: Identity, action: ActionDefinition, input: unknown): Promise<{ decision: PolicyDecision; typeName: string; target?: ActionTarget }> {
    const typeName = action.target?.type ?? action.applicableTypes[0] ?? "unknown";
    const objectId = action.target && typeof input === "object" && input !== null ? (input as Record<string, unknown>)[action.target.idFrom] : undefined;
    if (typeof objectId !== "string" || objectId === "") return { decision: await this.authorizeInvoke(identity, action, typeName), typeName };

    const typeDef = await this.requireType(typeName);
    let read: { stored: ResolvedProperties; attributes: Attributes };
    try {
      read = await this.authorizeRead(typeDef, objectId, identity);
    } catch (err) {
      if (err instanceof AuthorizationError) return { decision: { allow: false, reason: err.reason ?? err.message }, typeName };
      throw err;
    }
    const { stored, attributes } = read;
    const decision = await this.authorizeInvoke(identity, action, typeName, { objectId, attributes });
    return { decision, typeName, target: { typeName, objectId, attributes, typeDef, stored } };
  }

  /**
   * What preconditions and the adapter see: for an instance-scoped Action,
   * `getProperty` reads the authorized target's stored values as the
   * caller's own read shows them (ADR-0053). A value classified out or
   * denied by its property policy reads as undefined, and `onWithheld` is
   * told, so a precondition over it is not decided for this caller.
   */
  private actionContext(identity: Identity, input: unknown, target: ActionTarget | undefined, onWithheld?: () => void): ActionContext {
    return {
      identity,
      input,
      ...(target ? { target: { typeName: target.typeName, objectId: target.objectId } } : {}),
      getAdapter: (dataSourceId: string) => this.getAdapter(dataSourceId),
      getProperty: async (name: string) => {
        if (!target) throw new Error("getProperty is available only to an instance-scoped Action (ADR-0053); resolve the object via getObject first");
        if (!(await this.targetReadable(identity, target, name))) {
          onWithheld?.();
          return undefined;
        }
        return target.attributes[name];
      }
    };
  }

  /**
   * Whether the caller's read of an Action's target shows `name`, decided as
   * `finalizeValues` decides it: classification, then the member's own
   * marking and policy. Decided whether or not the target has a value for
   * it, so withholding says nothing about whether one exists.
   */
  private targetReadable(identity: Identity, target: ActionTarget, name: string): Promise<boolean> {
    const decided = (target.readable ??= new Map<string, Promise<boolean>>());
    let readable = decided.get(name);
    if (!readable) {
      readable = (async () => {
        target.classified ??= this.classifiedOut(target.typeDef, target.objectId, identity, { ...target.stored.values }, target.stored.provenance);
        if ((await target.classified).has(name)) return false;
        const resource = { typeName: target.typeName, objectId: target.objectId, propertyPath: name };
        if (!(await this.clearedFor(identity, memberMarkings(target.typeDef, name), resource))) return false;
        const policyName = memberPolicyOf(target.typeDef, name);
        return !policyName || (await this.evaluate(identity, "read", policyName, { ...resource, attributes: target.attributes })).allow;
      })();
      decided.set(name, readable);
    }
    return readable;
  }

  /**
   * The model as this caller may learn it (ADR-0068), under the deployment's
   * `discovery`: the whole model when it is `"open"`, or `"authenticated"`
   * and the caller is not anonymous; refused to an anonymous caller
   * otherwise; under `"need-to-know"`, only what the caller could use,
   * decided for them (and their audience, ADR-0067) by the same policies,
   * plans and markings their reads and invocations are. Every transport that
   * describes the model calls this, so none decides it on its own. One audit
   * row per call records the mode and what was described, by count.
   */
  async describeModel(identity: Identity, opts: DescribeModelOptions = {}): Promise<ModelDescription> {
    return this.withRequest("describeModel", () => this.instrument(
      "SemanticRuntime.describeModel",
      "model",
      this.telemetry.subject(identity),
      async () => {
        await this.checkRateLimit(identity);
        const resource: PolicyResource = { typeName: "*", actionName: "describe-model" };
        if (this.discovery !== "open" && isAnonymous(principalsOf(identity).person)) {
          const reason = "Describing the model needs an authenticated caller";
          await this.audit(identity, "read", resource, { allow: false, reason }, { discovery: this.discovery });
          throw new AuthorizationError("Not authorized: describe the model", reason);
        }
        const { model, withheld } = await this.modelFor(identity, opts);
        await this.audit(identity, "read", resource, { allow: true }, { discovery: this.discovery, types: model.types.length, actions: model.actions.length, ...(withheld ? { withheld } : {}) });
        return model;
      }
    ));
  }

  /** The model as `identity` may learn of it (ADR-0068), not audited: each public caller audits its own call. */
  private async modelFor(identity: Identity, opts: DescribeModelOptions = {}): Promise<{ model: ModelDescription; withheld?: Withheld }> {
    const full = await describeModel(this.registry, opts);
    if (this.discovery !== "need-to-know") return { model: full };
    const definitions = new Map((await this.registry.listTypes()).map((t) => [t.name, t]));
    const actionDefinitions = new Map((await this.registry.listActions()).map((a) => [a.name, a]));
    return narrowModel(full, definitions, actionDefinitions, this.discoveryGate(identity));
  }

  /**
   * The enforcement structure of the model as `identity` may learn of it
   * (ADR-0088): sources and mappings, the policy and markings guarding each
   * Type, member and Action, what each computed value derives from and is
   * released from, and each policy's rule as the engine describes it. Only
   * for an inspector the deployment's `inspection.policy` admits, and never
   * more of the model than their own discovery describes. `types` narrows it
   * to those Types (and the Actions on them).
   */
  async inspectModel(identity: Identity, opts: { types?: readonly string[] } = {}): Promise<ModelInspection> {
    return this.withRequest("inspectModel", () => this.instrument(
      "SemanticRuntime.inspectModel",
      "model",
      this.telemetry.subject(identity),
      async () => {
        await this.checkRateLimit(identity);
        await this.requireInspector(identity);
        const { model } = await this.modelFor(identity);
        const wanted = opts.types ? new Set(opts.types) : undefined;
        const selected: ModelDescription = wanted
          ? { ...model, types: model.types.filter((t) => wanted.has(t.name)), actions: model.actions.filter((a) => a.applicableTypes.some((t) => wanted.has(t))) }
          : model;
        const gate: InspectionGate = {
          markingKnowable: (marking) => this.clearedToKnow(identity, [marking], { typeName: "*" }, "read"),
          describePolicy: async (name) => {
            if (typeof this.policyEngine.describe !== "function") return undefined;
            try {
              const text: unknown = await this.policyEngine.describe(name);
              return typeof text === "string" ? text.slice(0, 4_000) : undefined;
            } catch {
              return undefined;
            }
          },
          connected: (id) => this.adapters.has(id)
        };
        return buildInspection(this.registry, selected, this.discovery === "need-to-know", gate, this.classification.name);
      }
    ));
  }

  /**
   * Whether `identity` may inspect the enforcement structure (ADR-0088),
   * decided by the inspection policy and audited: for code beside the
   * runtime (the workflow engine's explanations) that must apply the same
   * rule. `false`, without a decision, when no inspection is configured.
   */
  async canInspect(identity: Identity): Promise<boolean> {
    return this.withRequest("inspectModel", () => this.mayInspect(identity));
  }

  /** Whether `identity` may inspect (ADR-0088), decided and audited once; `false` without asking when no inspection is configured. */
  private async mayInspect(identity: Identity): Promise<boolean> {
    if (!this.inspection || isAnonymous(principalsOf(identity).person)) return false;
    return (await this.evaluate(identity, "read", this.inspection.policy, { typeName: "*", actionName: "inspect-model" })).allow;
  }

  /**
   * Why `question` is allowed, refused, partly answered or unavailable for a
   * subject (ADR-0089): the investigator's own access, or with `opts.as`
   * someone else's, which needs the inspection policy. The operation is run
   * as the subject through the runtime's own decision path with nothing
   * executed and every value discarded; what is kept is each decision, its
   * control and, for an inspector, the policy and rule behind it. Only what
   * the investigator may learn of is named: a Type, member or Action their
   * own discovery withholds is answered as unknown, and an object they may
   * not read themselves is refused to them as their own read would be.
   */
  async explain(question: ExplainQuestion, investigator: Identity, opts: ExplainOptions = {}): Promise<Explanation> {
    try {
      return await this.explainOnce(question, investigator, opts);
    } catch (err) {
      // Every attempt is on the record with the subject it was about, refused or failed as much as answered.
      const subjectId = typeof opts.as?.subjectId === "string" ? opts.as.subjectId : investigator.subjectId;
      const kind = typeof (question as { kind?: unknown } | null)?.kind === "string" ? (question as { kind: string }).kind : "invalid";
      await this.withRequest("explain", () =>
        this.audit(investigator, "read", { typeName: "*", actionName: "explain" }, { allow: false, reason: err instanceof Error ? err.message : "failed" }, { control: "explain", question: kind, subject: subjectId, outcome: err instanceof AuthorizationError ? "refused" : err instanceof NotFoundError ? "not-found" : err instanceof InvalidInputError ? "invalid" : "error" })
      ).catch(() => undefined);
      throw err;
    }
  }

  private async explainOnce(question: ExplainQuestion, investigator: Identity, opts: ExplainOptions): Promise<Explanation> {
    const shape = explainShapeError(question, opts);
    if (shape) throw new InvalidInputError(`Invalid explain question: ${shape}`);
    await this.checkRateLimit(investigator);
    const subject = opts.as ?? investigator;
    const self = opts.as === undefined;
    // The investigator's own checks run in a request of their own, so the trace below holds only the subject's decisions.
    const prepared = await this.withRequest("explain", async () => {
      const inspector = await this.mayInspect(investigator);
      if (!self && !inspector) {
        const reason = this.inspection ? "Explaining another subject's access needs the inspection policy" : "Inspection is not configured for this runtime";
        await this.audit(investigator, "read", { typeName: "*", actionName: "explain" }, { allow: false, reason }, { control: "inspection" });
        throw new AuthorizationError("Not authorized: explain another subject's access", this.toldReason(reason, investigator));
      }
      const { model: seen } = await this.modelFor(investigator);
      const subjectModel = this.discovery === "need-to-know" && !self ? (await this.modelFor(subject)).model : seen;
      return { inspector, seen, subjectModel };
    });
    const { inspector, seen, subjectModel } = prepared;
    const trace: TraceEntry[] = [];
    const replay = <T>(fn: () => Promise<T>): Promise<T> =>
      requests.run({ owner: this, budget: new Semaphore(this.maxConcurrency), operation: "explain", explanation: { investigator: investigator.subjectId, trace } }, fn);
    const asInvestigator = <T>(fn: () => Promise<T>): Promise<T> => requests.run({ owner: this, budget: new Semaphore(this.maxConcurrency), operation: "explain", charged: true }, fn);
    // The investigator's own read, with its decisions kept: what they may not read themselves, they are not told of for the subject either.
    const mine: TraceEntry[] = [];
    const asInvestigatorTraced = <T>(fn: () => Promise<T>): Promise<T> =>
      requests.run({ owner: this, budget: new Semaphore(this.maxConcurrency), operation: "explain", explanation: { investigator: investigator.subjectId, trace: mine }, charged: true }, fn);
    const notTold = (about: string, member: string | undefined): Finding => ({ about, ...(member ? { member } : {}), outcome: "not-told", basis: "evaluated", reason: "you may not read this yourself, so how it is decided for the subject is not told" });
    let observedMembers: ReadonlySet<string> | undefined;
    let observedObjects: ReadonlySet<string> | undefined;

    const told = (reason: string | undefined) => (inspector ? reason : this.toldReason(reason, subject));
    const controlShown = inspector || this.discovery === "open";
    const findings: Finding[] = [];
    const ruleOf = async (policy: string | undefined): Promise<string | undefined> => {
      if (!policy || !inspector || typeof this.policyEngine.describe !== "function") return undefined;
      try {
        const text: unknown = await this.policyEngine.describe(policy);
        return typeof text === "string" ? text.slice(0, 4_000) : undefined;
      } catch {
        return undefined;
      }
    };
    const knowable = (markings: readonly string[] | undefined) => (markings ?? []).filter((m) => this.clearedToKnow(investigator, [m], { typeName: "*" }, "read"));
    /** A finding from the decision that made it, disclosed as far as the investigator may be told. */
    const fromEntry = async (about: string, member: string | undefined, outcome: Finding["outcome"], entry: TraceEntry, control: NonNullable<Finding["control"]>): Promise<Finding> => {
      const policy = entry.control === "policy" || entry.control === "row-plan" ? entry.policy : undefined;
      const rule = await ruleOf(policy);
      const markings = inspector ? knowable(entry.markings) : [];
      let remedy: string | undefined;
      if (inspector) {
        if (entry.byAudience && subject.audience) remedy = `${subject.audience.id} must be allowed this too: decisions about an audience are made for the audience as well as the person (ADR-0067)`;
        else if (control === "classification") remedy = markings.length ? `the subject's clearance must dominate ${markings.join(", ")}` : "the subject needs a higher clearance";
        else if (control === "row-plan" && rule) remedy = `the object policy admits no object of this Type for the subject; it allows when ${rule}`;
        else if (control === "derivation") remedy = `readable only where ${(entry.inputs ?? []).join(", ")} ${(entry.inputs ?? []).length === 1 ? "is" : "are"}; or the domain releases ${(entry.inputs ?? []).length === 1 ? "it" : "them"} in x-computed, a reviewable assertion that the value does not disclose ${(entry.inputs ?? []).length === 1 ? "it" : "them"} (ADR-0052)`;
        else if (rule) remedy = `allowed when ${rule}`;
      }
      return {
        about,
        ...(member ? { member } : {}),
        outcome,
        basis: "evaluated",
        ...(controlShown ? { control: entry.byAudience ? "audience" : control } : {}),
        ...(inspector && policy ? { policy } : {}),
        ...(rule ? { rule } : {}),
        ...(entry.reason === undefined || (outcome === "withheld" && !inspector) ? {} : { reason: told(entry.reason)! }),
        ...(inspector && (control === "derivation" || control === "release") && entry.inputs?.length ? { inputs: entry.inputs } : {}),
        ...(inspector && control === "release" && entry.released?.length ? { inputs: entry.released } : {}),
        ...(markings.length ? { markings } : {}),
        ...(remedy ? { remedy } : {})
      };
    };
    const controlOf = (e: TraceEntry, member: boolean): NonNullable<Finding["control"]> =>
      e.control === "classification" ? "classification" : e.control === "derivation" ? "derivation" : e.control === "row-plan" ? "row-plan" : e.actionName ? "action-policy" : member ? "member-policy" : "object-policy";
    const sourceFinding = (about: string): Finding | undefined => {
      const failed = trace.find((e) => e.control === "source");
      if (!failed) return undefined;
      return { about, outcome: "unavailable", basis: "evaluated", control: "source", reason: failed.reason ?? "unavailable", ...(inspector && failed.policy ? { source: failed.policy } : {}) };
    };
    const denies = (filter: (e: TraceEntry) => boolean) => trace.filter((e) => e.subjectId === subject.subjectId && !e.allow && filter(e));
    let outcome: ExplanationOutcome = "allowed";
    let observedFor: { typeName: string; objectId?: string; actionName?: string } | undefined;
    let effects: Explanation["effects"];

    const unknown = (what: string) => new NotFoundError(what);
    if (question.kind === "read" || question.kind === "relationship") {
      const tDesc = seen.types.find((t) => t.name === question.type);
      if (!tDesc) throw unknown(`Unknown type "${question.type}"`);
      const typeDef = await this.requireType(question.type);
      const about = `${question.type}/${question.id}`;
      observedFor = { typeName: question.type, objectId: question.id };
      observedMembers = new Set([...Object.keys(tDesc.properties), ...tDesc.computed.map((c) => c.name), ...tDesc.relationships.map((r) => r.name)]);
      let mineValues: Record<string, unknown> | undefined;
      let mineUndecided = false;
      if (!self) {
        try {
          mineValues = (await asInvestigatorTraced(() => this.readObject(question.type, question.id, investigator))).object.values;
        } catch (err) {
          // A source failing the investigator's own read leaves their access to each value undecided: they may still read the
          // object, and are then told nothing about a value that has a policy, a marking or inputs of its own.
          if (!sourceFailure(err)) throw err;
          await asInvestigator(() => this.authorizeRead(typeDef, question.id, investigator));
          mineUndecided = true;
        }
      }
      const guarded = (member: string) => memberPolicyOf(typeDef, member) !== undefined || memberMarkings(typeDef, member).length > 0 || typeDef.computedProperties.some((c) => c.name === member);
      const deniedToMe = (member: string) =>
        (mineUndecided && guarded(member)) || (mineValues !== undefined && !(member in mineValues) && mine.some((x) => x.subjectId === investigator.subjectId && !x.allow && x.objectId === question.id && x.propertyPath === member));
      const subjectType = subjectModel.types.find((t) => t.name === question.type);
      if (!subjectType) {
        findings.push({ about: question.type, outcome: "refused", basis: "evaluated", ...(controlShown ? { control: "discovery" } : {}), ...(inspector ? { remedy: "need-to-know discovery does not describe this Type to the subject: they may read no object of it (ADR-0068)" } : {}) });
        outcome = "refused";
      } else if (question.kind === "read") {
        let values: Record<string, unknown> | undefined;
        try {
          values = (await replay(() => this.readObject(question.type, question.id, subject))).object.values;
        } catch (err) {
          if (err instanceof ObjectNotFoundError) {
            findings.push({ about, outcome: "not-found", basis: "evaluated" });
            outcome = "not-found";
          } else if (err instanceof AuthorizationError) {
            const e = denies((x) => x.typeName === question.type && x.objectId === question.id && x.propertyPath === undefined)[0];
            findings.push(e ? await fromEntry(about, undefined, "refused", e, controlOf(e, false)) : { about, outcome: "refused", basis: "evaluated", reason: told(err.reason) ?? "Not authorized" });
            outcome = "refused";
          } else if (sourceFailure(err)) {
            findings.push(sourceFinding(about) ?? { about, outcome: "unavailable", basis: "evaluated", control: "source", reason: sourceFailure(err)! });
            outcome = "unavailable";
          } else throw err;
        }
        if (values) {
          const members = [...Object.keys(tDesc.properties), ...tDesc.computed.map((c) => c.name)];
          const subjectMembers = new Set([...Object.keys(subjectType.properties), ...subjectType.computed.map((c) => c.name)]);
          for (const member of members) {
            const at = `${about}.${member}`;
            if (deniedToMe(member)) {
              findings.push(notTold(at, member));
              continue;
            }
            if (member in values) {
              const release = trace.find((x) => x.subjectId === subject.subjectId && x.allow && x.control === "derivation" && x.objectId === question.id && x.propertyPath === member);
              findings.push(release ? await fromEntry(at, member, "returned", release, "release") : { about: at, member, outcome: "returned", basis: "evaluated" });
              continue;
            }
            if (!subjectMembers.has(member)) {
              findings.push({ about: at, member, outcome: "withheld", basis: "evaluated", ...(controlShown ? { control: "discovery" } : {}), ...(inspector ? { remedy: "need-to-know discovery does not describe this value to the subject (ADR-0068)" } : {}) });
              continue;
            }
            const ranked = denies((x) => x.objectId === question.id && x.propertyPath === member);
            const e = ranked.find((x) => x.control === "classification") ?? ranked.find((x) => x.control === "policy") ?? ranked.find((x) => x.control === "derivation");
            findings.push(e ? await fromEntry(at, member, "withheld", e, controlOf(e, true)) : { about: at, member, outcome: "no-value", basis: "evaluated", ...(inspector ? { reason: "the source holds no value for it on this object, or the computation returned none" } : {}) });
          }
          outcome = findings.some((f) => f.outcome === "withheld") ? "partial" : "allowed";
        }
      } else {
        const relDesc = tDesc.relationships.find((r) => r.name === question.relationship);
        if (!relDesc) throw unknown(`Unknown relationship "${question.relationship}" on type "${question.type}"`);
        const relDef = typeDef.relationships.find((r) => r.name === question.relationship)!;
        const at = `${about}.${question.relationship}`;
        let returned: Set<string> | undefined;
        try {
          returned = new Set((await replay(() => this.readRelationship(question.type, question.id, question.relationship, subject))).map((r) => r.object.objectId));
        } catch (err) {
          if (err instanceof ObjectNotFoundError) {
            findings.push({ about, outcome: "not-found", basis: "evaluated" });
            outcome = "not-found";
          } else if (err instanceof AuthorizationError) {
            const e = denies((x) => x.typeName === question.type && x.objectId === question.id && (x.propertyPath === undefined || x.propertyPath === question.relationship))[0];
            findings.push(e ? await fromEntry(e.propertyPath ? at : about, e.propertyPath, "refused", e, controlOf(e, e.propertyPath !== undefined)) : { about, outcome: "refused", basis: "evaluated", reason: told(err.reason) ?? "Not authorized" });
            outcome = "refused";
          } else if (sourceFailure(err)) {
            findings.push(sourceFinding(at) ?? { about: at, outcome: "unavailable", basis: "evaluated", control: "source", reason: sourceFailure(err)! });
            outcome = "unavailable";
          } else throw err;
        }
        // Another subject's related objects are counted only among those the investigator is returned themselves.
        let readable: ReadonlySet<string> | undefined = returned;
        if (returned && !self) {
          readable = deniedToMe(question.relationship)
            ? undefined
            : await asInvestigator(() => this.readRelationship(question.type, question.id, question.relationship, investigator)).then(
                (rs) => new Set(rs.map((r) => r.object.objectId)),
                () => undefined
              );
          if (!readable) findings.push(notTold(at, question.relationship));
        }
        if (returned && readable) {
          const count = [...returned].filter((id) => readable.has(id)).length;
          findings.push({ about: at, member: question.relationship, outcome: "returned", basis: "evaluated", count, reason: self ? `${count} related object${count === 1 ? "" : "s"} returned` : `${count} of the ${readable.size} related object${readable.size === 1 ? "" : "s"} you are returned ${count === 1 ? "is" : "are"} returned to the subject` });
          // Dangling references are named only to an investigator who may learn of the Type they would be.
          if (!self && seen.types.some((t) => t.name === relDef.targetType)) {
            // Each related object the investigator may read and the subject was not returned, and why. Objects the investigator may not read are not counted.
            const refs = await asInvestigator(() => this.resolveRelationship(this.getAdapter(relDef.resolution.dataSourceId), typeDef, relDef, question.id));
            if (refs.length > this.queryLimits.maxRelatedPerObject) findings.push({ about: at, member: question.relationship, outcome: "truncated", basis: "structural", control: "relationship", reason: `only the first ${this.queryLimits.maxRelatedPerObject} related objects are read (maxRelatedPerObject, ADR-0028)` });
            const targetDef = await this.requireType(relDef.targetType);
            for (const ref of refs.slice(0, Math.min(this.queryLimits.maxRelatedPerObject, 50))) {
              if (returned.has(ref.objectId)) continue;
              const target = `${relDef.targetType}/${ref.objectId}`;
              // Whether the object exists is asked of its source before any policy: a policy that decides on the object's
              // values would otherwise deny a missing one, and the reference would go uncounted for that investigator.
              const held = await asInvestigator(() => this.resolveObjectProperties(targetDef, ref.objectId)).then(
                (r) => Object.keys(r.values).length > 0,
                (err: unknown) => (err instanceof ObjectNotFoundError ? false : undefined)
              );
              if (held === false) {
                findings.push({ about: target, outcome: "dangling", basis: "evaluated", control: "relationship", reason: `${question.relationship} names ${ref.objectId}, which its source does not hold (ADR-0048): the reference is left out` });
                continue;
              }
              try {
                await asInvestigator(() => this.authorizeRead(targetDef, ref.objectId, investigator));
              } catch {
                continue;
              }
              const e = denies((x) => x.typeName === relDef.targetType && x.objectId === ref.objectId && x.propertyPath === undefined)[0];
              findings.push(e ? await fromEntry(target, undefined, "refused", e, controlOf(e, false)) : { about: target, outcome: "refused", basis: "evaluated" });
            }
          }
          outcome = findings.some((f) => f.outcome === "refused" || f.outcome === "dangling") ? "partial" : "allowed";
        }
      }
    } else if (question.kind === "invoke") {
      const aDesc = seen.actions.find((a) => a.name === question.action);
      if (!aDesc) throw unknown(`Unknown action "${question.action}"`);
      const action = (await this.registry.getAction(question.action))!;
      const targetId = action.target && typeof question.input === "object" && question.input !== null ? (question.input as Record<string, unknown>)[action.target.idFrom] : undefined;
      const targetType = action.target?.type ?? action.applicableTypes[0] ?? "unknown";
      observedFor = { typeName: targetType, actionName: action.name, ...(typeof targetId === "string" ? { objectId: targetId } : {}) };
      if (!self && typeof targetId === "string" && targetId !== "") {
        try {
          await asInvestigator(async () => this.authorizeRead(await this.requireType(targetType), targetId, investigator));
        } catch (err) {
          // The investigator may read the Type and the id names nothing: theirs to learn, as their own read would tell them.
          if (!(err instanceof ObjectNotFoundError)) throw err;
          findings.push({ about: `${targetType}/${targetId}`, outcome: "not-found", basis: "evaluated", control: "target", reason: err.message });
          return this.explanation(question, subject, investigator, inspector, "not-found", findings, []);
        }
      }
      const policyFinding = async (allowed: boolean): Promise<Finding> => {
        const e = trace.find((x) => x.subjectId === subject.subjectId && x.actionName === action.name && x.allow === allowed && (x.control === "policy" || x.control === "classification"));
        if (e) return fromEntry(action.name, undefined, allowed ? "allowed" : "refused", e, e.control === "classification" ? "classification" : "action-policy");
        return { about: action.name, outcome: allowed ? "allowed" : "refused", basis: "evaluated", ...(controlShown ? { control: "action-policy" } : {}) };
      };
      if (!subjectModel.actions.some((a) => a.name === action.name)) {
        findings.push({ about: action.name, outcome: "refused", basis: "evaluated", ...(controlShown ? { control: "discovery" } : {}), ...(inspector ? { remedy: "need-to-know discovery does not describe this Action to the subject: its policy admits them on no object, or they may read no object it acts on (ADR-0068)" } : {}) });
        outcome = "refused";
      } else {
        let preview: ActionPreview | undefined;
        try {
          preview = await replay(() => this.previewAction(action.name, question.input, subject));
        } catch (err) {
          if (err instanceof AuthorizationError || err instanceof NotFoundError) {
            findings.push({ about: action.name, outcome: "refused", basis: "evaluated", reason: told(err instanceof AuthorizationError ? err.reason : "Not authorized") ?? "Not authorized" });
            outcome = "refused";
          } else if (sourceFailure(err)) {
            findings.push(sourceFinding(action.name) ?? { about: action.name, outcome: "unavailable", basis: "evaluated", control: "source", reason: sourceFailure(err)! });
            outcome = "unavailable";
          } else throw err;
        }
        if (preview) {
          const target = preview.target ?? (typeof targetId === "string" ? { typeName: targetType, objectId: targetId } : undefined);
          const targetRefused = target ? denies((x) => x.typeName === target.typeName && x.objectId === target.objectId && x.actionName === undefined)[0] : undefined;
          for (const b of preview.blockers) {
            if (b.kind === "authorization") {
              if (targetRefused) findings.push(await fromEntry(`${target!.typeName}/${target!.objectId}`, undefined, "refused", targetRefused, "target"));
              else findings.push(await policyFinding(false));
            } else if (b.kind === "target") findings.push({ about: target ? `${target.typeName}/${target.objectId}` : action.name, outcome: "not-found", basis: "evaluated", control: "target", reason: b.message });
            else if (b.kind === "input") findings.push({ about: action.name, outcome: "invalid", basis: "evaluated", control: "input", reason: b.message });
          }
          if (preview.authorized) findings.push(await policyFinding(true));
          for (const p of preview.preconditions) {
            if (p.satisfied === null && !preview.blockers.some((b) => b.kind === "precondition" && b.message.includes(p.description))) continue;
            findings.push({ about: action.name, outcome: p.satisfied === true ? "allowed" : p.satisfied === false ? "refused" : "withheld", basis: "evaluated", control: "precondition", reason: p.satisfied === null ? `not decided: ${p.description} (it reads a value the subject may not read)` : p.description });
          }
          outcome = preview.wouldExecute ? "allowed" : preview.blockers.some((b) => b.kind === "input") && preview.authorized ? "invalid" : preview.blockers.some((b) => b.kind === "target") ? "not-found" : "refused";
          effects = { sideEffects: action.sideEffects, idempotency: action.idempotency, auditRequired: action.auditRequired, ...(inspector ? { source: action.implementation.dataSourceId } : {}) };
        }
      }
    } else {
      let q: ReturnType<InputValidator["validateQuery"]>;
      try {
        q = this.inputValidator.validateQuery(question.query);
      } catch (err) {
        if (!(err instanceof InvalidInputError)) throw err;
        findings.push({ about: "query", outcome: "invalid", basis: "evaluated", control: "input", reason: err.message });
        return this.explanation(question, subject, investigator, inspector, "invalid", findings, []);
      }
      const tDesc = seen.types.find((t) => t.name === q.type);
      if (!tDesc) throw unknown(`Unknown type "${q.type}"`);
      observedFor = { typeName: q.type };
      observedMembers = new Set([...Object.keys(tDesc.properties), ...tDesc.computed.map((c) => c.name), ...tDesc.relationships.map((r) => r.name)]);
      const typeDef = await this.requireType(q.type);
      const myPage = self ? undefined : await asInvestigator(() => this.query(question.query, investigator));
      if (myPage) observedObjects = new Set(myPage.items.map((o) => o.objectId));
      let theirs: Set<string> | undefined;
      try {
        theirs = new Set((await replay(() => this.query(question.query, subject))).items.map((o) => o.objectId));
      } catch (err) {
        if (err instanceof AuthorizationError) {
          const e = denies((x) => x.typeName === q.type && x.objectId === undefined)[0];
          findings.push(e ? await fromEntry(q.type, undefined, "refused", e, controlOf(e, false)) : { about: q.type, outcome: "refused", basis: "evaluated", reason: told(err.reason) ?? "Not authorized" });
          outcome = "refused";
        } else if (sourceFailure(err)) {
          findings.push(sourceFinding(q.type) ?? { about: q.type, outcome: "unavailable", basis: "evaluated", control: "source", reason: sourceFailure(err)! });
          outcome = "unavailable";
        } else throw err;
      }
      if (theirs) {
        // Another subject's rows are counted, and explained, only among those the investigator is returned themselves.
        const shown = observedObjects ? [...theirs].filter((id) => observedObjects!.has(id)).length : theirs.size;
        findings.push({ about: q.type, outcome: "returned", basis: "evaluated", reason: observedObjects ? `${shown} of the ${observedObjects.size} object${observedObjects.size === 1 ? "" : "s"} you are returned on this page ${shown === 1 ? "is" : "are"} returned to the subject` : `${shown} object${shown === 1 ? "" : "s"} returned on this page` });
        for (const o of (myPage?.items ?? []).slice(0, 50)) {
          const at = `${q.type}/${o.objectId}`;
          if (!theirs.has(o.objectId)) {
            let refused = denies((x) => x.typeName === q.type && x.objectId === o.objectId && x.propertyPath === undefined)[0];
            if (!refused) {
              // Excluded in the source by the subject's plan (ADR-0038), so never decided one by one: decided now.
              await replay(() => this.authorizeRead(typeDef, o.objectId, subject)).catch(() => undefined);
              refused = denies((x) => x.typeName === q.type && x.objectId === o.objectId && x.propertyPath === undefined)[0];
            }
            if (refused) findings.push(await fromEntry(at, undefined, "refused", refused, controlOf(refused, false)));
          }
        }
        outcome = findings.some((f) => f.outcome === "refused") ? "partial" : "allowed";
      }
    }

    let observed: ObservedDecision[] = [];
    if (inspector && observedFor) {
      const rows = (await this.registry.listAuditEvents({ limit: 500 })).items;
      observed = rows
        .filter((r) => r.subjectId === subject.subjectId && r.operation !== "explain" && r.resource.typeName === observedFor.typeName && (observedFor.objectId === undefined || r.resource.objectId === observedFor.objectId) && (observedFor.actionName === undefined || r.action === observedFor.actionName))
        // Never a value the investigator's discovery withholds, nor an object their own page leaves out.
        .filter((r) => (r.resource.propertyPath === undefined || observedMembers === undefined || observedMembers.has(r.resource.propertyPath)) && (r.resource.objectId === undefined || observedObjects === undefined || observedObjects.has(r.resource.objectId)))
        .slice(0, 20)
        .map((r) => ({ at: r.timestamp, ...(r.operation ? { operation: r.operation } : {}), action: r.action, ...(r.resource.propertyPath ? { member: r.resource.propertyPath } : {}), decision: r.decision, ...(r.reason ? { reason: r.reason } : {}) }));
    }
    return this.explanation(question, subject, investigator, inspector, outcome, findings, observed, effects);
  }

  private async explanation(question: ExplainQuestion, subject: Identity, investigator: Identity, inspector: boolean, outcome: ExplanationOutcome, findings: Finding[], observed: ObservedDecision[], effects?: Explanation["effects"]): Promise<Explanation> {
    await this.withRequest("explain", () =>
      this.audit(investigator, "read", { typeName: "*", actionName: "explain" }, { allow: true }, { control: "explain", question: question.kind, subject: subject.subjectId, outcome, disclosure: inspector ? "inspector" : "caller" })
    );
    return {
      format: EXPLANATION_FORMAT,
      question,
      subject: subject.subjectId,
      ...(subject.audience ? { audience: subject.audience.id } : {}),
      investigator: investigator.subjectId,
      disclosure: inspector ? "inspector" : "caller",
      outcome,
      summary: summarize(outcome, findings, subject.subjectId),
      findings,
      ...(effects ? { effects } : {}),
      observed,
      caveat: EXPLANATION_CAVEAT
    };
  }

  /** Whether `identity` may inspect (ADR-0088): an inspection policy is configured, the caller is authenticated, and the policy allows them (and their audience). Audited either way. */
  private async requireInspector(identity: Identity): Promise<void> {
    const resource: PolicyResource = { typeName: "*", actionName: "inspect-model" };
    const refuse = async (reason: string): Promise<never> => {
      await this.audit(identity, "read", resource, { allow: false, reason }, { control: "inspection" });
      throw new AuthorizationError("Not authorized: inspect the model", this.toldReason(reason, identity));
    };
    if (!this.inspection) return refuse("Inspection is not configured for this runtime");
    if (isAnonymous(principalsOf(identity).person)) return refuse("Inspecting the model needs an authenticated caller");
    const decision = await this.evaluate(identity, "read", this.inspection.policy, resource);
    if (!decision.allow) throw new AuthorizationError("Not authorized: inspect the model", this.toldReason(decision.reason, identity));
  }

  /** Why a refusal happened, as the caller may be told it: masked for an audience (ADR-0067), withheld unless discovery is open (ADR-0068). */
  private toldReason(reason: string | undefined, identity: Identity): string {
    if (identity.audience) return `Refused while reading for ${identity.audience.id}`;
    if (this.discovery !== "open") return "Not authorized";
    return reason ?? "Not authorized";
  }

  /** The questions need-to-know asks for one caller (ADR-0068), each decided without reading an object and not audited on its own. */
  private discoveryGate(identity: Identity): DiscoveryGate {
    return {
      typeReadable: async (typeDef) =>
        this.clearedToKnow(identity, objectMarkings(typeDef), { typeName: typeDef.name }, "read") &&
        this.admitsSome(identity, "read", objectPolicyOf(typeDef), { typeName: typeDef.name }),
      memberReadable: async (typeDef, member) => {
        const at: PolicyResource = { typeName: typeDef.name, propertyPath: member };
        if (!this.clearedToKnow(identity, memberMarkings(typeDef, member), at, "read")) return false;
        const policyName = memberPolicyOf(typeDef, member);
        return !policyName || this.admitsSome(identity, "read", policyName, at);
      },
      actionInvocable: async (action, typeName) => {
        const at: PolicyResource = { typeName, actionName: action.name };
        return (await this.admitsSome(identity, "invoke", action.authorizationPolicy, at)) && this.clearedToKnow(identity, await this.actionMarkings(action), at, "invoke");
      }
    };
  }

  /**
   * Whether need-to-know would describe `action` to this caller (ADR-0068),
   * by `narrowModel`'s rule: invocable on some Type the caller may read, and
   * acting on a Type they may read.
   */
  private async actionDescribed(identity: Identity, action: ActionDefinition): Promise<boolean> {
    const gate = this.discoveryGate(identity);
    const readable = async (typeName: string) => {
      const typeDef = await this.registry.getType(typeName);
      return typeDef !== undefined && (await gate.typeReadable(typeDef));
    };
    if (action.target?.type && !(await readable(action.target.type))) return false;
    for (const typeName of action.applicableTypes) if ((await readable(typeName)) && (await gate.actionInvocable(action, typeName))) return true;
    return false;
  }

  /**
   * Whether the caller may learn of something under `markings` (ADR-0068).
   * Not audited on its own: discovery decides many of these per call, and
   * `describeModel` audits the call as one row.
   */
  private clearedToKnow(identity: Identity, markings: readonly string[], resource: PolicyResource, action: "read" | "invoke"): boolean {
    return this.classify(identity, markings, resource, action).allow;
  }

  /**
   * Whether `policyName` admits this caller on some resource of its Type
   * (ADR-0068): its plan is not `never`. A plan the engine cannot make is
   * decided for the Type with no object, where an attribute rule denies, so
   * a policy nobody can plan shows less, never more.
   */
  private async admitsSome(identity: Identity, action: "read" | "invoke", policyName: string, resource: PolicyResource): Promise<boolean> {
    const plan = await this.askPlanner({ subject: identity, action, policyName, resource });
    if (plan.kind === "never") return false;
    if (plan.kind !== "unknown") return true;
    return (await this.decide({ subject: identity, action, policyName, resource })).allow;
  }

  /**
   * The Actions applicable to `typeName`, each with whether this caller may
   * invoke it. Pass `objectId` to decide instance-scoped Actions on that
   * object (ADR-0053); without it they are decided per Type, where an
   * attribute rule denies.
   */
  async listActions(typeName: string, identity: Identity, opts: { objectId?: string } = {}): Promise<ListedAction[]> {
    return this.withRequest("listActions", () => this.instrument(
      "SemanticRuntime.listActions",
      typeName,
      this.telemetry.subject(identity),
      async () => {
        await this.checkRateLimit(identity);
        // Which Actions exist is discovery too (ADR-0068): refused or narrowed as describeModel is.
        if (this.discovery !== "open" && isAnonymous(principalsOf(identity).person)) {
          throw new AuthorizationError(`Not authorized: list Actions on ${typeName}`, "Describing the model needs an authenticated caller");
        }
        const needToKnow = this.discovery === "need-to-know";
        if (needToKnow) {
          const typeDef = await this.registry.getType(typeName);
          if (!typeDef || !this.clearedToKnow(identity, objectMarkings(typeDef), { typeName }, "read") || !(await this.admitsSome(identity, "read", objectPolicyOf(typeDef), { typeName }))) return [];
        }
        const all = await this.registry.listActions();
        const applicable = all.filter((a) => a.applicableTypes.includes(typeName));
        const results: ListedAction[] = [];
        for (const action of applicable) {
          // A preview is still an authorization decision disclosed to the caller, so it is decided and audited
          // exactly as invokeAction decides it.
          const instanceScoped = action.target !== undefined;
          const onThis = instanceScoped && opts.objectId !== undefined && (action.target!.type ?? action.applicableTypes[0]) === typeName;
          const authorized = onThis
            ? (await this.gateAction(identity, action, { [action.target!.idFrom]: opts.objectId })).decision.allow
            : (await this.authorizeInvoke(identity, action, typeName)).allow;
          // Under need-to-know an Action is listed only to a caller it admits: here, or on some object for an
          // instance-scoped one listed without an object, as describeModel decides it.
          // Under need-to-know an Action is listed only when describeModel would describe it: invocable on some
          // Type the caller may read, and acting on one they may read.
          const listed = !needToKnow || (await this.actionDescribed(identity, action));
          if (listed) results.push({ action, authorized, instanceScoped });
        }
        return results;
      }
    ));
  }

  /**
   * Decides `invokeAction(actionName, input)` for this caller without
   * executing it (ADR-0053): authorization (on the target, for an
   * instance-scoped Action), then input validation, then each precondition,
   * which may read through adapters as it would on a real call. Nothing is
   * dispatched to `executeAction`. Every decision is audited as on a real
   * call, under operation `previewAction`, plus one row recording the
   * preview's outcome.
   */
  async previewAction(actionName: string, input: unknown, identity: Identity): Promise<ActionPreview> {
    const action = await this.registry.getAction(actionName);
    if (!action) throw new NotFoundError(`Unknown action "${actionName}"`);
    return this.withRequest("previewAction", () => this.instrument(
      "SemanticRuntime.previewAction",
      action.applicableTypes[0] ?? "unknown",
      { "typesys.action_name": action.name, ...this.telemetry.subject(identity) },
      async () => {
        await this.checkRateLimit(identity);
        // A preview describes an Action: refused or withheld as listActions and describeModel are (ADR-0068). A
        // withheld Action is answered exactly as one that does not exist; the audit row says which it was.
        const resource: PolicyResource = { typeName: action.applicableTypes[0] ?? "unknown", actionName: action.name };
        if (this.discovery !== "open" && isAnonymous(principalsOf(identity).person)) {
          const reason = "Describing the model needs an authenticated caller";
          await this.audit(identity, "invoke", resource, { allow: false, reason }, { control: "preview", discovery: this.discovery });
          throw new AuthorizationError(`Not authorized: preview ${action.name}`, reason);
        }
        if (this.discovery === "need-to-know" && !(await this.actionDescribed(identity, action))) {
          await this.audit(identity, "invoke", resource, { allow: false, reason: "Withheld by need-to-know discovery" }, { control: "preview", discovery: this.discovery });
          throw new NotFoundError(`Unknown action "${actionName}"`);
        }
        const blockers: ActionBlocker[] = [];
        const preconditions: ActionPreview["preconditions"] = (action.preconditions ?? []).map((p) => ({ description: p.description, satisfied: null }));
        let inputValid: boolean | null = null;
        let gate: Awaited<ReturnType<SemanticRuntime["gateAction"]>> | undefined;
        try {
          gate = await this.gateAction(identity, action, input);
          // Told as invokeAction's refusal is (ADR-0067), and without the policy's reason when discovery is not open
          // (ADR-0068): which roles or attributes a policy wants describes it. The audit row keeps the reason.
          if (!gate.decision.allow) blockers.push({ kind: "authorization", message: this.toldReason(gate.decision.reason, identity) });
        } catch (err) {
          // Raised only after the caller was allowed to read the target type: the id names no object.
          if (!(err instanceof ObjectNotFoundError)) throw err;
          blockers.push({ kind: "target", message: err.message });
        }

        if (blockers.length === 0 && gate) {
          try {
            this.inputValidator.validateActionInput(action, input);
            inputValid = true;
          } catch (err) {
            if (!(err instanceof InvalidInputError)) throw err;
            inputValid = false;
            blockers.push({ kind: "input", message: err.message });
          }
        }

        if (blockers.length === 0 && gate) {
          for (const [i, precondition] of (action.preconditions ?? []).entries()) {
            let withheld = false;
            const ctx = this.actionContext(identity, input, gate.target, () => (withheld = true));
            let satisfied: boolean;
            try {
              satisfied = (await precondition.check(ctx)) === true;
            } catch {
              satisfied = false;
            }
            // Over a value the caller may not read, the outcome would disclose it: reported as not decided.
            if (withheld) {
              blockers.push({ kind: "precondition", message: `Precondition not decided: ${precondition.description} (it reads a value this caller may not read)` });
              continue;
            }
            preconditions[i]!.satisfied = satisfied;
            if (!satisfied) blockers.push({ kind: "precondition", message: `Precondition failed: ${precondition.description}` });
          }
        }

        const typeName = gate?.typeName ?? action.applicableTypes[0] ?? "unknown";
        const target = gate?.target ? { typeName: gate.target.typeName, objectId: gate.target.objectId } : undefined;
        const wouldExecute = blockers.length === 0;
        await this.audit(
          identity,
          "invoke",
          { typeName, actionName: action.name, ...(target ? { objectId: target.objectId } : {}) },
          wouldExecute ? { allow: true } : { allow: false, reason: `Preview: blocked by ${blockers.map((b) => b.kind).join(", ")}` },
          { control: "preview", blockers: blockers.map((b) => b.kind) }
        );
        return {
          action: action.name,
          version: action.version,
          ...(target ? { target } : {}),
          authorized: gate?.decision.allow === true,
          inputValid,
          preconditions,
          blockers,
          wouldExecute,
          effects: { sideEffects: action.sideEffects, idempotency: action.idempotency, auditRequired: action.auditRequired }
        };
      }
    ));
  }

  /**
   * An Action's result as a caller reading for an audience may receive it
   * (ADR-0075). The effect has happened; what goes back to the model is
   * decided like a read: the object the result describes (the Action's
   * target, or its `outputType` named by the result's `id`) is read as the
   * person and the audience, and the result keeps only the values that read
   * returns. A result describing no object the runtime can decide, or one
   * the read refuses, is withheld: `{}` for an object, `null` otherwise.
   */
  private async releaseActionResult(
    action: ActionDefinition,
    result: unknown,
    target: { typeName: string; objectId: string } | undefined,
    identity: Identity
  ): Promise<{ value: unknown; withheld: string[] }> {
    const isRecord = result !== null && typeof result === "object" && !Array.isArray(result);
    const nothing = { value: isRecord ? {} : null, withheld: isRecord ? Object.keys(result) : ["(result)"] };
    if (!isRecord) return nothing;
    const id = (result as Record<string, unknown>).id;
    // The object the result is: the declared output Type's object it names, or the target when the result names the target.
    const subject =
      action.outputType && typeof id === "string"
        ? { typeName: action.outputType, objectId: id }
        : target && id === target.objectId
          ? target
          : undefined;
    if (!subject) return nothing;
    let values: Record<string, unknown>;
    try {
      const typeDef = await this.requireType(subject.typeName);
      const { stored, attributes } = await this.authorizeRead(typeDef, subject.objectId, identity);
      ({ values } = await this.finalizeValues(typeDef, subject.objectId, identity, stored, attributes));
    } catch (err) {
      if (err instanceof AuthorizationError || err instanceof NotFoundError) return nothing;
      throw err;
    }
    const value: Record<string, unknown> = {};
    const withheld: string[] = [];
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      // The id names the object the caller was just allowed to read.
      if (Object.hasOwn(values, k) || (k === "id" && v === subject.objectId)) value[k] = v;
      else withheld.push(k);
    }
    return { value, withheld };
  }

  async invokeAction(actionName: string, input: unknown, identity: Identity): Promise<unknown> {
    const action = await this.registry.getAction(actionName);
    if (!action) throw new NotFoundError(`Unknown action "${actionName}"`);
    const primaryType = action.applicableTypes[0] ?? "unknown";

    return this.withRequest("invokeAction", () => this.instrument(
      "SemanticRuntime.invokeAction",
      primaryType,
      { "typesys.action_name": action.name, ...this.telemetry.subject(identity) },
      async () => {
        await this.checkRateLimit(identity);
        const { decision, typeName, target } = await this.gateAction(identity, action, input);
        if (!decision.allow) throw notAuthorized("invoke", { typeName, actionName: action.name }, decision.reason, identity);
        // After the policy check, so every attempt by an unauthorized caller is still audited as a
        // deny; before preconditions, which read `input` and would otherwise see unchecked shapes.
        this.inputValidator.validateActionInput(action, input);

        const ctx = this.actionContext(identity, input, target);
        for (const precondition of action.preconditions ?? []) {
          let withheld = false;
          const ok = await precondition.check(this.actionContext(identity, input, target, () => (withheld = true)));
          // A precondition over a value the caller may not read refuses whatever it returned, so neither the
          // outcome nor the error tells the caller anything about that value (ADR-0053).
          if (withheld) {
            throw new PreconditionFailedError(`Precondition failed for action "${actionName}": ${precondition.description} (it reads a value the caller may not read)`);
          }
          if (!ok) {
            throw new PreconditionFailedError(`Precondition failed for action "${actionName}": ${precondition.description}`);
          }
        }

        const adapter = this.getAdapter(action.implementation.dataSourceId);
        const result = await adapter.executeAction(action, input, ctx);
        // The target was read before the write; a cached copy of it is now stale.
        if (target && action.sideEffects !== "none") await this.invalidateObject(target.typeName, target.objectId);

        // What an audience receives of the result is decided like any read of it (ADR-0075).
        // An Action that declares its output Type has its result released to a person the same way: as a read of that object.
        const released = identity.audience || action.outputType ? await this.releaseActionResult(action, result, target, identity) : { value: result, withheld: [] };

        if (action.auditRequired) {
          await this.registry.appendAuditEvent({
            id: ulid(),
            timestamp: new Date().toISOString(),
            subjectId: identity.subjectId,
            operation: "invokeAction",
            action: action.name,
            resource: { typeName, ...(target ? { objectId: target.objectId } : {}) },
            decision: "allow",
            outcome: "success",
            ...(identity.audience ? { details: { audience: identity.audience.id, withheld: released.withheld } } : released.withheld.length ? { details: { withheld: released.withheld } } : {})
          });
        }

        return released.value;
      }
    ));
  }
}

/** The provenance an adapter result carries: a property bundle's, or every item's of a query page. */
function provenanceIn(result: unknown): ProvenanceRef[] {
  if (result === null || typeof result !== "object") return [];
  const own = (result as { provenance?: unknown }).provenance;
  if (Array.isArray(own)) return own as ProvenanceRef[];
  const items = (result as { items?: unknown }).items;
  if (Array.isArray(items)) return items.flatMap((i: unknown) => provenanceIn(i));
  return [];
}

/** Errors raised by a nested include's own required relationship, which an outer optional include must not absorb. */
const NESTED_FAILURES = new WeakSet<object>();

/** Where each adapter method takes its `AdapterCallOptions` (see `Adapter`). */
const OPTIONS_INDEX: Readonly<Record<string, number>> = { resolveProperties: 3, queryByType: 5, resolveRelationship: 2, executeAction: 3, aggregate: 1 };

/**
 * `args` with the deadline's signal in the method's options position: missing
 * arguments before it are left `undefined`, and options the caller passed keep
 * everything but their signal. A method that takes no options gets `args` as they are.
 */
function withSignal(method: PropertyKey, args: readonly unknown[], signal: AbortSignal): unknown[] {
  const at = typeof method === "string" && Object.hasOwn(OPTIONS_INDEX, method) ? OPTIONS_INDEX[method] : undefined;
  if (at === undefined) return [...args];
  const out = [...args];
  while (out.length < at) out.push(undefined);
  const given = out[at];
  out[at] = given !== null && typeof given === "object" ? { ...given, signal } : { signal };
  return out.slice(0, at + 1);
}
