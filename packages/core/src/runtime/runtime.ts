import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "ulid";
import type { SemanticRegistry } from "../registry/registry.js";
import { MappingResolver } from "./mapping-resolver.js";
import type { Adapter, ResolvedProperties, RelatedRef } from "./adapter.js";
import type { Identity, PolicyDecision, PolicyEngine, PolicyRequest, PolicyResource } from "../model/policy.js";
import type { TypeDefinition, ComputedPropertyDefinition } from "../model/type.js";
import type { ActionDefinition } from "../model/action.js";
import type { RelationshipDefinition } from "../model/relationship.js";
import type { Mapping } from "../model/data-source.js";
import type { ProvenanceRef } from "../model/provenance.js";
import type { SemanticQuery, QueryFilter, QueryInclude, QueryResult, SortKey, SearchSpec, SemanticAggregateQuery, AggregateResult } from "../model/query.js";
import type { ComputeContext, ActionContext } from "../model/context.js";
import { InputValidator, type QueryLimits } from "./input-validation.js";
import { AuthorizationError, AuthorizationPlanError, InvalidInputError, NotFoundError, PreconditionFailedError, RateLimitExceededError, AggregationNotSupportedError } from "./errors.js";
import { AdapterResilience, type ResiliencePolicy } from "./resilience.js";
import { DENY_MARKED_DATA, isMarked, memberMarkings, objectMarkings, valueMarkings, type ClassificationScheme } from "./classification.js";
import { type Cache, NoopCache } from "./cache.js";
import { type RateLimiter, NoopRateLimiter } from "./rate-limiter.js";
import { mapWithConcurrency, mapWithConcurrencySettled, Semaphore } from "./concurrency.js";
import { filterProperties, matchesFilter } from "./filter.js";
import { applyProjection, applySort } from "./query-ops.js";
import { instrumentOperation, annotateActiveSpan } from "../observability/tracing.js";
import { recordPolicyDecision, recordCacheResult, recordPlanDefect } from "../observability/metrics.js";
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
 * How `query` treats a read policy it can't plan exactly (ADR-0038):
 * `"post-filter"` reads with whatever plan there is and decides every object
 * after the read; `"require-exact"` refuses the query instead.
 */
export type RowSecurity = "post-filter" | "require-exact";

/** What `explainQuery` reports (ADR-0038). Runtime-only: it reveals what the policy tests and the subject's own values. */
export interface QueryPlanReport {
  typeName: string;
  policyName: string;
  rowSecurity: RowSecurity;
  /** The plan as `query` would apply it, fitted to where the Type's data is. */
  plan: AuthorizationPlan;
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

function notAuthorized(action: "read" | "invoke", resource: PolicyResource, reason?: string): AuthorizationError {
  const target = resource.actionName ?? resource.propertyPath ?? resource.objectId;
  return new AuthorizationError(`Not authorized: ${action} ${resource.typeName}${target ? `/${target}` : ""}`, reason);
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
   * See ADR-0019 and `withRequestBudget`.
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
   * What `query` does with a read policy it can't plan exactly (ADR-0038).
   * Default `"post-filter"`: read with the best plan there is, decide every
   * object after the read. `"require-exact"`: refuse such a query.
   */
  rowSecurity?: RowSecurity;
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
  /** The concurrency budget of this runtime's call currently executing, if any (see `withRequestBudget`). */
  private readonly requestBudget = new AsyncLocalStorage<Semaphore>();

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
    this.mappingResolver = new MappingResolver(registry);
    this.adapters = new Map(adapters.map((a) => [a.dataSourceId, a]));
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
    const store = this.requestBudget;
    const resilience = this.resilience;

    // `exit` runs the adapter call outside this request's budget, so an adapter that itself calls
    // back into a runtime starts a fresh budget instead of deadlocking on permits it can't get.
    // Resolved per call (not once), so it holds across resilience retries and after backoff sleeps.
    const underBudget = (invoke: () => Promise<unknown>): Promise<unknown> => {
      const budget = store.getStore();
      return budget ? budget.run(() => store.exit(invoke)) : invoke();
    };

    return new Proxy(adapter, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...a: unknown[]) => Promise<unknown>;

        // No resilience policy: the exact pre-ADR-0026 path — budget only, original args, no signal.
        if (resilience.isNoop) {
          return (...args: unknown[]) => underBudget(() => method.apply(target, args));
        }

        // With a policy the breaker/timeout/retry wrap the budget, so backoff sleeps don't hold a
        // permit and each attempt takes a fresh one (ADR-0026). The deadline's signal is appended as
        // the method's optional trailing `AdapterCallOptions`; runtime call sites never pass one, so
        // appending is unambiguous, and it's added only when a timeout is actually configured.
        return (...args: unknown[]) => {
          const retryable = isRetryableAdapterCall(prop, args);
          return resilience.run(dataSourceId, retryable, (signal) => {
            const callArgs = signal ? [...args, { signal }] : args;
            return underBudget(() => method.apply(target, callArgs));
          });
        };
      }
    });
  }

  /**
   * Runs `fn` inside one request-wide concurrency budget of `maxConcurrency`
   * adapter calls. Nested runtime calls (getRelationship's per-object
   * getObject, include trees, provenance recursion) find the budget already
   * set and share it, so the cap holds for the whole request rather than
   * per fan-out level, where nested levels would multiply it.
   */
  private withRequestBudget<T>(fn: () => Promise<T>): Promise<T> {
    if (this.requestBudget.getStore()) return fn();
    return this.requestBudget.run(new Semaphore(this.maxConcurrency), fn);
  }

  private async checkRateLimit(identity: Identity): Promise<void> {
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
    let decision: PolicyDecision | undefined;
    try {
      decision = await this.policyEngine.evaluate(request);
    } catch {
      return { allow: false, reason: `Policy "${request.policyName}" failed to evaluate (fail closed)` };
    }
    if (decision?.allow === true) return decision;
    return { allow: false, reason: typeof decision?.reason === "string" ? decision.reason : `Policy "${request.policyName}" did not allow (fail closed)` };
  }

  /** Records one decision. The row names what was decided about, never `resource.attributes`. */
  private async audit(
    identity: Identity,
    action: "read" | "invoke",
    resource: PolicyResource,
    decision: PolicyDecision,
    details?: Record<string, unknown>
  ): Promise<void> {
    recordPolicyDecision(decision.allow ? "allow" : "deny");
    await this.registry.appendAuditEvent({
      id: ulid(),
      timestamp: new Date().toISOString(),
      subjectId: identity.subjectId,
      action: resource.actionName ?? action,
      resource: { typeName: resource.typeName, objectId: resource.objectId, propertyPath: resource.propertyPath },
      decision: decision.allow ? "allow" : "deny",
      reason: decision.reason,
      ...(details ? { details } : {})
    });
  }

  /** Decides and audits one policy check. */
  private async evaluate(identity: Identity, action: "read" | "invoke", policyName: string, resource: PolicyResource): Promise<PolicyDecision> {
    const decision = await this.decide({ subject: identity, action, policyName, resource });
    await this.audit(identity, action, resource, decision);
    return decision;
  }

  private async requireAllowed(identity: Identity, action: "read" | "invoke", policyName: string, resource: PolicyResource): Promise<void> {
    const decision = await this.evaluate(identity, action, policyName, resource);
    if (!decision.allow) throw notAuthorized(action, resource, decision.reason);
  }

  /**
   * Whether the subject's clearance dominates `marking` (unmarked: always).
   * Deny-biased: a scheme that throws denies. It does not audit: a decision
   * about access goes through `clearedFor`, which does.
   */
  private dominates(identity: Identity, marking: string): boolean {
    try {
      return this.classification.dominates(identity.clearance, marking) === true;
    } catch {
      return false;
    }
  }

  /**
   * Decides and audits one classification check (ADR-0032): the subject's
   * clearance must dominate every marking. A mandatory control beside the
   * policy engine, never through it, so no engine can relax it. Unmarked
   * data — no markings — is no decision and writes nothing (ADR-0034).
   */
  private async clearedFor(
    identity: Identity,
    markings: readonly string[],
    resource: PolicyResource,
    action: "read" | "invoke" = "read"
  ): Promise<boolean> {
    const marked = [...new Set(markings)];
    if (marked.length === 0) return true;
    const allow = marked.every((m) => this.dominates(identity, m));
    const details = { control: "classification", scheme: this.classification.name, markings: marked, clearance: identity.clearance ?? null };
    await this.audit(identity, action, resource, allow ? { allow } : { allow, reason: CLEARANCE_REASON }, details);
    return allow;
  }

  private async requireCleared(
    identity: Identity,
    markings: readonly string[],
    resource: PolicyResource,
    action: "read" | "invoke" = "read"
  ): Promise<void> {
    if (!(await this.clearedFor(identity, markings, resource, action))) throw notAuthorized(action, resource, CLEARANCE_REASON);
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

  /**
   * The engine's plan, checked. An engine without a planner plans `unknown`;
   * one that throws or returns anything malformed — or claims an exactness
   * its limitations contradict — is a planner defect, and plans `unknown`
   * too: sound, and never exact, so `require-exact` refuses it.
   */
  private async askPlanner(request: PolicyRequest): Promise<AuthorizationPlan> {
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
  private async authorizeInvoke(identity: Identity, action: ActionDefinition, typeName: string): Promise<PolicyDecision> {
    const resource = { typeName, actionName: action.name };
    const decision = await this.evaluate(identity, "invoke", action.authorizationPolicy, resource);
    if (!decision.allow) return decision;
    const cleared = await this.clearedFor(identity, await this.actionMarkings(action), resource, "invoke");
    return cleared ? decision : { allow: false, reason: CLEARANCE_REASON };
  }

  /**
   * The instance-level read check every path shares: the object's
   * classification first, before anything is read (ADR-0032), then its
   * stored values and the object policy decided on them (ADR-0030). Throws
   * `AuthorizationError` on a deny, after auditing it.
   */
  private async authorizeRead(
    typeDef: TypeDefinition,
    objectId: string,
    identity: Identity
  ): Promise<{ stored: ResolvedProperties; attributes: Attributes }> {
    await this.requireCleared(identity, objectMarkings(typeDef), { typeName: typeDef.name, objectId });
    const stored = await this.resolveObjectProperties(typeDef, objectId);
    const attributes = snapshot(stored.values);
    await this.requireAllowed(identity, "read", objectPolicyOf(typeDef), { typeName: typeDef.name, objectId, attributes });
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
    provenance: ProvenanceRef[]
  ): Promise<Set<string>> {
    const own = (name: string) => new Set([...memberMarkings(typeDef, name), ...valueMarkings(provenance.filter((p) => p.propertyPath === name))]);
    const effective = new Map(Object.keys(values).map((name) => [name, own(name)]));
    // Declaration order: a computed property's computed dependencies are already known.
    for (const cp of typeDef.computedProperties) {
      const markings = own(cp.name);
      for (const dep of cp.dependsOn) for (const m of effective.get(dep) ?? []) markings.add(m);
      effective.set(cp.name, markings);
    }

    const hidden = new Set<string>();
    for (const [name, markings] of effective) {
      if (!(name in values)) continue;
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
    const values: Record<string, unknown> = { ...resolved.values };
    const computedResults: Record<string, unknown> = {};

    const ctx: ComputeContext = {
      identity,
      objectId,
      typeName: typeDef.name,
      getAdapter: (dataSourceId: string) => this.getAdapter(dataSourceId),
      getProperty: async (name: string) => {
        if (name in values) return values[name];
        if (name in computedResults) return computedResults[name];
        throw new Error(`Property "${name}" not available for computed-property dependency resolution`);
      }
    };

    const uncacheable = await this.uncacheableComputed(typeDef, resolved);
    for (const cp of typeDef.computedProperties) {
      computedResults[cp.name] = await this.resolveComputed(cp, typeDef.name, objectId, ctx, !uncacheable.has(cp.name));
    }
    Object.assign(values, computedResults);

    // Classification first, over every value, before policies remove any (ADR-0032).
    const classified = await this.classifiedOut(typeDef, objectId, identity, values, resolved.provenance);
    for (const name of classified) delete values[name];

    const propertyPolicies = typeDef.schema["x-policy"]?.propertyPolicies ?? {};
    for (const [propName, policyName] of Object.entries(propertyPolicies)) {
      if (!(propName in values)) continue;
      const decision = await this.evaluate(identity, "read", policyName, {
        typeName: typeDef.name,
        objectId,
        propertyPath: propName,
        attributes
      });
      if (!decision.allow) delete values[propName];
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
    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.getObject",
      typeName,
      { "typesys.object_id": objectId, "typesys.identity.subject_id": identity.subjectId },
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
    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.getRelationship",
      typeName,
      { "typesys.object_id": objectId, "typesys.relationship_name": relationshipName, "typesys.identity.subject_id": identity.subjectId },
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
        // (existing behavior) without aborting the rest of a partially-authorized batch.
        const settled = await mapWithConcurrencySettled(bounded, this.maxConcurrency, (ref) =>
          this.readObject(relDef.targetType, ref.objectId, identity)
        );

        const results: AuthorizedRead[] = [];
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") {
            results.push(outcome.value);
          } else if (!(outcome.reason instanceof AuthorizationError)) {
            throw outcome.reason;
          }
        }
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
    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.query",
      typeof claimedType === "string" ? claimedType : "unknown",
      { "typesys.identity.subject_id": identity.subjectId },
      async () => {
        await this.checkRateLimit(identity);
        const q = this.inputValidator.validateQuery(input);
        annotateActiveSpan({ "typesys.query.limit": q.limit });
        const typeDef = await this.requireType(q.type);
        // A classified Type is decided before the adapter runs: an uncleared caller gets an empty page, and
        // nothing of the Type is read on their behalf (ADR-0032). The object policy, by contrast, has no
        // type-level gate: it is decided per returned item, below (ADR-0030).
        if (!(await this.clearedFor(identity, objectMarkings(typeDef), { typeName: q.type }))) return { items: [] };
        if (q.filter) {
          this.rejectComputedFilterProperties(typeDef, q.filter);
          await this.requireReadableProperties(typeDef, filterProperties(q.filter), identity);
        }
        if (q.sort) {
          this.rejectComputedSortProperties(typeDef, q.sort);
          await this.requireReadableProperties(typeDef, q.sort.map((s) => s.property), identity);
        }
        // `search` desugars to an `icontains` OR-filter over resolved, readable, non-computed
        // properties, AND-combined with any explicit filter (ADR-0027).
        const effectiveFilter = await this.resolveSearchFilter(typeDef, q.filter, q.search, identity);

        // The read policy as a filter the adapter applies before it reads (ADR-0038). A sound
        // over-approximation: whatever it excludes, the policy would have denied. Every object it admits
        // is still decided below.
        const plan = await this.planRead(typeDef, identity);
        const typeResource = { typeName: q.type };
        if (this.rowSecurity === "require-exact" && !isExact(plan)) {
          const codes = limitationsOf(plan).map((l) => l.code).join(", ");
          const message = `Refused under rowSecurity "require-exact": policy "${objectPolicyOf(typeDef)}" has no exact plan for this subject (${codes})`;
          await this.audit(identity, "read", typeResource, { allow: false, reason: message }, { control: "row-plan", ...planSummary(plan) });
          throw new AuthorizationPlanError(message);
        }
        if (plan.kind === "never") {
          await this.audit(identity, "read", typeResource, { allow: false, reason: "No object of this Type is readable by this subject" }, { control: "row-plan", ...planSummary(plan) });
          return { items: [] };
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
        const result = await adapter.queryByType(q.type, plannedFilter, q.limit, q.cursor, q.sort);

        // Every item, and every `include` within an item, is independent — resolve the
        // whole O(items x includes) fan-out concurrently rather than one sequential
        // round trip at a time (the same N+1 pattern fixed in getRelationship above,
        // multiplied across a whole result page), bounded by maxConcurrency (ADR-0019)
        // so a large `limit` can't open unbounded concurrent adapter calls.
        const objectPolicy = objectPolicyOf(typeDef);
        const probed = new Set([...(effectiveFilter ? filterProperties(effectiveFilter) : []), ...(q.sort ?? []).map((s) => s.property)]);
        const items = await mapWithConcurrency(result.items, this.maxConcurrency, async (item) => {
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
            Object.assign(resolved.values, await this.resolveIncludes(q.type, item.objectId, attributes, q.include, identity));
          }
          return resolved;
        });
        return { items: items.filter((item) => item !== undefined), nextCursor: result.nextCursor };
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
    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.aggregate",
      typeof claimedType === "string" ? claimedType : "unknown",
      { "typesys.identity.subject_id": identity.subjectId },
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
          if (!(plan.kind === "predicate" && plan.exact)) throw notAuthorized("read", typeResource, typeLevel.reason);
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
    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.explainQuery",
      typeof claimedType === "string" ? claimedType : "unknown",
      { "typesys.identity.subject_id": identity.subjectId },
      async () => {
        await this.checkRateLimit(identity);
        const q = this.inputValidator.validateQuery(input);
        const typeDef = await this.requireType(q.type);
        const plan = await this.planRead(typeDef, identity);
        const computed = new Set(typeDef.computedProperties.map((c) => c.name));
        const searched = q.search ? (q.search.properties ?? Object.keys(typeDef.schema.properties ?? {}).filter((p) => !computed.has(p))) : [];
        const probes = [...new Set([...(q.filter ? filterProperties(q.filter) : []), ...(q.sort ?? []).map((s) => s.property), ...searched])];
        const exact = isExact(plan);
        await this.audit(identity, "read", { typeName: q.type }, { allow: true }, { control: "row-plan", operation: "explainQuery", ...planSummary(plan) });
        return {
          typeName: q.type,
          policyName: objectPolicyOf(typeDef),
          rowSecurity: this.rowSecurity,
          plan,
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
    return declared.filter((p) => !computed.has(p) && !gated.has(p) && memberMarkings(typeDef, p).every((m) => this.dominates(identity, m)));
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

  /**
   * The top-level filter runs in the adapter, which only has stored values;
   * computed properties don't exist until after it returns, so a condition
   * on one would silently match nothing. Reject it and point at the filter
   * that does work: an include-level filter runs on fully resolved objects.
   */
  private rejectComputedFilterProperties(typeDef: TypeDefinition, filter: QueryFilter): void {
    const computed = new Set(typeDef.computedProperties.map((c) => c.name));
    const used = [...filterProperties(filter)].filter((p) => computed.has(p));
    if (used.length > 0) {
      throw new InvalidInputError(
        `Invalid query: cannot filter "${typeDef.name}" on computed ${used.length === 1 ? "property" : "properties"} ` +
          `${used.map((p) => `"${p}"`).join(", ")} at the top level; computed values don't exist until after the ` +
          `adapter has filtered. Filter on it in an include instead, or filter the results client-side.`
      );
    }
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
    for (const property of propertyNames) {
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
          Object.assign(object.values, await this.resolveIncludes(object.typeName, object.objectId, relatedAttributes, nested, identity));
        });
      }
      return kept.map((r) => r.object);
    });
    return Object.fromEntries(includes.map((inc, i) => [inc.relationship, results[i]!]));
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
   */
  private async readProvenance(
    typeName: string,
    objectId: string,
    propertyPath: string,
    identity: Identity,
    source?: { typeDef: TypeDefinition; attributes: Attributes }
  ): Promise<ProvenanceRef[]> {
    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.getProvenance",
      typeName,
      { "typesys.object_id": objectId, "typesys.property_path": propertyPath, "typesys.identity.subject_id": identity.subjectId },
      async () => {
        await this.checkRateLimit(identity);
        const typeDef = source?.typeDef ?? (await this.requireType(typeName));
        const attributes = source?.attributes ?? (await this.authorizeRead(typeDef, objectId, identity)).attributes;
        await this.requireMemberReadable(typeDef, propertyPath, objectId, attributes, identity);

        const computed = typeDef.computedProperties.find((c) => c.name === propertyPath);
        if (computed) {
          const nested = await mapWithConcurrency(computed.dependsOn, this.maxConcurrency, (dep) =>
            this.readProvenance(typeName, objectId, dep, identity, { typeDef, attributes })
          );
          return nested.flat();
        }

        const mapping = await this.mappingResolver.resolvePropertyMapping(typeName, propertyPath);
        const adapter = this.getAdapter(mapping.dataSourceId);
        const resolved = await adapter.resolveProperties(typeName, objectId, [propertyPath]);
        const refs = resolved.provenance.filter((p) => p.propertyPath === propertyPath);
        // The value's own marking, known only once it has been read (ADR-0032).
        await this.requireCleared(identity, valueMarkings(refs), { typeName, objectId, propertyPath });
        return refs;
      }
    ));
  }

  async listActions(typeName: string, identity: Identity): Promise<{ action: ActionDefinition; authorized: boolean }[]> {
    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.listActions",
      typeName,
      { "typesys.identity.subject_id": identity.subjectId },
      async () => {
        await this.checkRateLimit(identity);
        const all = await this.registry.listActions();
        const applicable = all.filter((a) => a.applicableTypes.includes(typeName));
        const results: { action: ActionDefinition; authorized: boolean }[] = [];
        for (const action of applicable) {
          // A preview is still an authorization decision disclosed to the caller, so it is decided and audited
          // exactly as invokeAction decides it.
          results.push({ action, authorized: (await this.authorizeInvoke(identity, action, typeName)).allow });
        }
        return results;
      }
    ));
  }

  async invokeAction(actionName: string, input: unknown, identity: Identity): Promise<unknown> {
    const action = await this.registry.getAction(actionName);
    if (!action) throw new NotFoundError(`Unknown action "${actionName}"`);
    const primaryType = action.applicableTypes[0] ?? "unknown";

    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.invokeAction",
      primaryType,
      { "typesys.action_name": action.name, "typesys.identity.subject_id": identity.subjectId },
      async () => {
        await this.checkRateLimit(identity);
        const gate = await this.authorizeInvoke(identity, action, primaryType);
        if (!gate.allow) throw notAuthorized("invoke", { typeName: primaryType, actionName: action.name }, gate.reason);
        // After the policy check, so every attempt by an unauthorized caller is still audited as a
        // deny; before preconditions, which read `input` and would otherwise see unchecked shapes.
        this.inputValidator.validateActionInput(action, input);

        const ctx: ActionContext = {
          identity,
          input,
          getAdapter: (dataSourceId: string) => this.getAdapter(dataSourceId),
          getProperty: async () => {
            throw new Error("getProperty is not available in an action context; resolve the object via getObject first");
          }
        };

        for (const precondition of action.preconditions ?? []) {
          const ok = await precondition.check(ctx);
          if (!ok) {
            throw new PreconditionFailedError(`Precondition failed for action "${actionName}": ${precondition.description}`);
          }
        }

        const adapter = this.getAdapter(action.implementation.dataSourceId);
        const result = await adapter.executeAction(action, input, ctx);

        if (action.auditRequired) {
          await this.registry.appendAuditEvent({
            id: ulid(),
            timestamp: new Date().toISOString(),
            subjectId: identity.subjectId,
            action: action.name,
            resource: { typeName: primaryType },
            decision: "allow",
            outcome: "success"
          });
        }

        return result;
      }
    ));
  }
}
