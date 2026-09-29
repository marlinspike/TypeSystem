import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "ulid";
import type { SemanticRegistry } from "../registry/registry.js";
import { MappingResolver } from "./mapping-resolver.js";
import type { Adapter, ResolvedProperties, RelatedRef } from "./adapter.js";
import type { Identity, PolicyEngine } from "../model/policy.js";
import type { TypeDefinition, ComputedPropertyDefinition } from "../model/type.js";
import type { ActionDefinition } from "../model/action.js";
import type { RelationshipDefinition } from "../model/relationship.js";
import type { Mapping } from "../model/data-source.js";
import type { ProvenanceRef } from "../model/provenance.js";
import type { SemanticQuery, QueryFilter, QueryInclude, QueryResult, SortKey, SearchSpec, SemanticAggregateQuery, AggregateResult } from "../model/query.js";
import type { ComputeContext, ActionContext } from "../model/context.js";
import { InputValidator, type QueryLimits } from "./input-validation.js";
import { AuthorizationError, InvalidInputError, NotFoundError, PreconditionFailedError, RateLimitExceededError, AggregationNotSupportedError } from "./errors.js";
import { AdapterResilience, type ResiliencePolicy } from "./resilience.js";
import { type Cache, NoopCache } from "./cache.js";
import { type RateLimiter, NoopRateLimiter } from "./rate-limiter.js";
import { mapWithConcurrency, mapWithConcurrencySettled, Semaphore } from "./concurrency.js";
import { filterProperties, matchesFilter } from "./filter.js";
import { applyProjection, applySort } from "./query-ops.js";
import { instrumentOperation, annotateActiveSpan } from "../observability/tracing.js";
import { recordPolicyDecision, recordCacheResult } from "../observability/metrics.js";

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
  /** Omit to preserve pre-ADR-0016 "always live" behavior exactly — a `NoopCache` always misses. */
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
  private readonly defaultCacheTtlMs: number;
  private readonly rateLimiter: RateLimiter;
  private readonly maxConcurrency: number;
  private readonly resilience: AdapterResilience;
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
    this.defaultCacheTtlMs = options.defaultCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.rateLimiter = options.rateLimiter ?? new NoopRateLimiter();
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.inputValidator = new InputValidator(options.queryLimits);
    this.resilience = new AdapterResilience(options.resilience);
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
  private noteCacheOutcome(hit: boolean): void {
    recordCacheResult(hit ? "hit" : "miss");
    annotateActiveSpan({ "typesys.cache.hit": hit });
  }

  /** Cache is transparent here: same return shape whether it came from cache or the adapter (see ADR-0016). */
  private async resolveProperties(adapter: Adapter, mapping: Mapping, typeName: string, objectId: string): Promise<ResolvedProperties> {
    if (mapping.resolutionMode !== "cached") return adapter.resolveProperties(typeName, objectId, []);
    const key = this.propertyCacheKey(mapping.dataSourceId, typeName, objectId);
    const cached = await this.cache.get<ResolvedProperties>(key);
    if (cached) {
      this.noteCacheOutcome(true);
      return cached;
    }
    this.noteCacheOutcome(false);
    const resolved = await adapter.resolveProperties(typeName, objectId, []);
    await this.cache.set(key, resolved, mapping.cacheTtlMs ?? this.defaultCacheTtlMs);
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
    typeName: string,
    objectId: string,
    base: ResolvedProperties,
    overrides: Mapping[]
  ): Promise<ResolvedProperties> {
    if (overrides.length === 0) return base;

    const results = await mapWithConcurrency(overrides, this.maxConcurrency, async (mapping) => ({
      mapping,
      resolved: await this.resolveProperties(this.getAdapter(mapping.dataSourceId), mapping, typeName, objectId)
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
  private async resolveObjectProperties(typeName: string, objectId: string): Promise<ResolvedProperties> {
    const { base, overrides } = await this.mappingResolver.resolvePropertyMappings(typeName);
    const baseResolved = await this.resolveProperties(this.getAdapter(base.dataSourceId), base, typeName, objectId);
    return this.mergeOverrides(typeName, objectId, baseResolved, overrides);
  }

  private async resolveRelationship(adapter: Adapter, relDef: RelationshipDefinition, objectId: string): Promise<RelatedRef[]> {
    if (relDef.resolutionMode !== "cached") return adapter.resolveRelationship(relDef, objectId);
    const key = this.relationshipCacheKey(relDef.resolution.dataSourceId, relDef.name, objectId);
    const cached = await this.cache.get<RelatedRef[]>(key);
    if (cached) {
      this.noteCacheOutcome(true);
      return cached;
    }
    this.noteCacheOutcome(false);
    const refs = await adapter.resolveRelationship(relDef, objectId);
    await this.cache.set(key, refs, relDef.cacheTtlMs ?? this.defaultCacheTtlMs);
    return refs;
  }

  private async resolveComputed(
    cp: ComputedPropertyDefinition,
    typeName: string,
    objectId: string,
    ctx: ComputeContext
  ): Promise<unknown> {
    if (cp.resolutionMode !== "cached") return cp.compute(ctx);
    const key = this.computedCacheKey(typeName, objectId, cp.name);
    const cached = await this.cache.get(key);
    if (cached !== undefined) {
      this.noteCacheOutcome(true);
      return cached;
    }
    this.noteCacheOutcome(false);
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

  private async evaluate(
    identity: Identity,
    action: "read" | "invoke",
    policyName: string,
    resource: { typeName: string; objectId?: string; propertyPath?: string; actionName?: string }
  ) {
    const decision = await this.policyEngine.evaluate({ subject: identity, action, policyName, resource });
    recordPolicyDecision(decision.allow ? "allow" : "deny");
    await this.registry.appendAuditEvent({
      id: ulid(),
      timestamp: new Date().toISOString(),
      subjectId: identity.subjectId,
      action: resource.actionName ?? action,
      resource: { typeName: resource.typeName, objectId: resource.objectId, propertyPath: resource.propertyPath },
      decision: decision.allow ? "allow" : "deny",
      reason: decision.reason
    });
    return decision;
  }

  private async requireAllowed(
    identity: Identity,
    action: "read" | "invoke",
    policyName: string,
    resource: { typeName: string; objectId?: string; propertyPath?: string; actionName?: string }
  ): Promise<void> {
    const decision = await this.evaluate(identity, action, policyName, resource);
    if (!decision.allow) {
      const target = resource.actionName ?? resource.propertyPath ?? resource.objectId ?? resource.typeName;
      throw new AuthorizationError(`Not authorized: ${action} ${resource.typeName}/${target}`, decision.reason);
    }
  }

  private async finalizeValues(
    typeDef: TypeDefinition,
    objectId: string,
    identity: Identity,
    resolved: ResolvedProperties
  ): Promise<{ values: Record<string, unknown>; provenance: ProvenanceRef[] }> {
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

    for (const cp of typeDef.computedProperties) {
      computedResults[cp.name] = await this.resolveComputed(cp, typeDef.name, objectId, ctx);
    }
    Object.assign(values, computedResults);

    const propertyPolicies = typeDef.schema["x-policy"]?.propertyPolicies ?? {};
    for (const [propName, policyName] of Object.entries(propertyPolicies)) {
      if (!(propName in values)) continue;
      const decision = await this.evaluate(identity, "read", policyName, {
        typeName: typeDef.name,
        objectId,
        propertyPath: propName
      });
      if (!decision.allow) delete values[propName];
    }

    const provenance = resolved.provenance.filter((p) => p.propertyPath in values);
    return { values, provenance };
  }

  async getObject(
    typeName: string,
    objectId: string,
    identity: Identity,
    opts: { includeProvenance?: boolean } = {}
  ): Promise<ResolvedObject> {
    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.getObject",
      typeName,
      { "typesys.object_id": objectId, "typesys.identity.subject_id": identity.subjectId },
      async () => {
        await this.checkRateLimit(identity);
        const typeDef = await this.requireType(typeName);
        const objectPolicy = typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
        await this.requireAllowed(identity, "read", objectPolicy, { typeName, objectId });

        const resolved = await this.resolveObjectProperties(typeName, objectId);

        const { values, provenance } = await this.finalizeValues(typeDef, objectId, identity, resolved);
        return { typeName, objectId, values, ...(opts.includeProvenance ? { provenance } : {}) };
      }
    ));
  }

  async getRelationship(
    typeName: string,
    objectId: string,
    relationshipName: string,
    identity: Identity
  ): Promise<ResolvedObject[]> {
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

        const propertyPolicies = typeDef.schema["x-policy"]?.propertyPolicies ?? {};
        const relPolicy = propertyPolicies[relDef.name] ?? typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
        await this.requireAllowed(identity, "read", relPolicy, { typeName, objectId, propertyPath: relDef.name });

        const adapter = this.getAdapter(relDef.resolution.dataSourceId);
        const relatedRefs = await this.resolveRelationship(adapter, relDef, objectId);
        // Bound the *count* of the fan-out: a one-to-many with more related objects than
        // maxRelatedPerObject (ADR-0028) is truncated, the count-analogue of the maxConcurrency
        // bound on its concurrency (ADR-0019). The adapter's returned order is preserved.
        const bounded = relatedRefs.slice(0, this.queryLimits.maxRelatedPerObject);

        // Fan out concurrently, not one sequential round trip per related object — the classic
        // N+1 pattern for a one-to-many relationship. Bounded by maxConcurrency (ADR-0019) rather
        // than a raw Promise.allSettled, and an unauthorized related object is silently omitted
        // (existing behavior) without aborting the rest of a partially-authorized batch.
        const settled = await mapWithConcurrencySettled(bounded, this.maxConcurrency, (ref) =>
          this.getObject(relDef.targetType, ref.objectId, identity)
        );

        const results: ResolvedObject[] = [];
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
        const objectPolicy = typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
        await this.requireAllowed(identity, "read", objectPolicy, { typeName: q.type });
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

        // Listing/filtering/pagination is inherently single-source — only the base
        // mapping's adapter can answer "which objects match", so overrides (ADR-0023)
        // are merged per item below, not folded into this call.
        const { base, overrides } = await this.mappingResolver.resolvePropertyMappings(q.type);
        const adapter = this.getAdapter(base.dataSourceId);
        const result = await adapter.queryByType(q.type, effectiveFilter, q.limit, q.cursor, q.sort);

        // Every item, and every `include` within an item, is independent — resolve the
        // whole O(items x includes) fan-out concurrently rather than one sequential
        // round trip at a time (the same N+1 pattern fixed in getRelationship above,
        // multiplied across a whole result page), bounded by maxConcurrency (ADR-0019)
        // so a large `limit` can't open unbounded concurrent adapter calls.
        const items = await mapWithConcurrency(result.items, this.maxConcurrency, async (item) => {
          const merged = await this.mergeOverrides(q.type, item.objectId, { values: item.values, provenance: item.provenance }, overrides);
          const { values, provenance } = await this.finalizeValues(typeDef, item.objectId, identity, merged);
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
            Object.assign(resolved.values, await this.resolveIncludes(q.type, item.objectId, q.include, identity));
          }
          return resolved;
        });
        return { items, nextCursor: result.nextCursor };
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
        const objectPolicy = typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
        await this.requireAllowed(identity, "read", objectPolicy, { typeName: q.type });

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
        return adapter.aggregate(q);
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
    return declared.filter((p) => !computed.has(p) && !gated.has(p));
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
   * answer it. Checked per Type, not per object: a policy that only allows
   * some objects' values denies the whole query, failing closed.
   */
  private async requireReadableProperties(typeDef: TypeDefinition, propertyNames: Iterable<string>, identity: Identity): Promise<void> {
    const propertyPolicies = typeDef.schema["x-policy"]?.propertyPolicies ?? {};
    for (const property of propertyNames) {
      const policyName = propertyPolicies[property];
      if (!policyName) continue;
      await this.requireAllowed(identity, "read", policyName, { typeName: typeDef.name, propertyPath: property });
    }
  }

  /**
   * Resolves one object's `include` tree (ADR-0011), keyed by relationship
   * name. Each entry navigates through `getRelationship`, so relationship
   * policy and per-object redaction apply exactly as on a direct call; then
   * the entry's own `filter` runs against each related object's *visible*
   * values, and its nested `include` recurses from each survivor. Filtering
   * after redaction treats a property the caller can't read as absent, so
   * an include filter can never be used to probe a hidden value.
   */
  private async resolveIncludes(
    typeName: string,
    objectId: string,
    includes: QueryInclude[],
    identity: Identity
  ): Promise<Record<string, ResolvedObject[]>> {
    const results = await mapWithConcurrency(includes, this.maxConcurrency, async (inc) => {
      const related = await this.getRelationship(typeName, objectId, inc.relationship, identity);
      const filtered = inc.filter ? related.filter((r) => matchesFilter(r.values, inc.filter)) : related;
      // Sort then limit the related set (ADR-0028), post-resolution — so an include sort may
      // reference computed properties (unlike a top-level sort) and both see already-redacted values.
      const sorted = inc.sort ? applySort(filtered, inc.sort, (r) => r.values) : filtered;
      const kept = inc.limit != null ? sorted.slice(0, inc.limit) : sorted;
      // Projection (ADR-0027) runs AFTER filter/sort/limit (which see full visible values) and
      // BEFORE nested includes are assigned, so those survive it.
      if (inc.select) {
        for (const r of kept) r.values = applyProjection(r.values, inc.select);
      }
      const nested = inc.include;
      if (nested && nested.length > 0) {
        await mapWithConcurrency(kept, this.maxConcurrency, async (r) => {
          Object.assign(r.values, await this.resolveIncludes(r.typeName, r.objectId, nested, identity));
        });
      }
      return kept;
    });
    return Object.fromEntries(includes.map((inc, i) => [inc.relationship, results[i]!]));
  }

  async getProvenance(
    typeName: string,
    objectId: string,
    propertyPath: string,
    identity: Identity
  ): Promise<ProvenanceRef[]> {
    return this.withRequestBudget(() => instrumentOperation(
      "SemanticRuntime.getProvenance",
      typeName,
      { "typesys.object_id": objectId, "typesys.property_path": propertyPath, "typesys.identity.subject_id": identity.subjectId },
      async () => {
        await this.checkRateLimit(identity);
        const typeDef = await this.requireType(typeName);
        const propertyPolicies = typeDef.schema["x-policy"]?.propertyPolicies ?? {};
        const policyName = propertyPolicies[propertyPath] ?? typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
        await this.requireAllowed(identity, "read", policyName, { typeName, objectId, propertyPath });

        const computed = typeDef.computedProperties.find((c) => c.name === propertyPath);
        if (computed) {
          const nested = await mapWithConcurrency(computed.dependsOn, this.maxConcurrency, (dep) =>
            this.getProvenance(typeName, objectId, dep, identity)
          );
          return nested.flat();
        }

        const mapping = await this.mappingResolver.resolvePropertyMapping(typeName, propertyPath);
        const adapter = this.getAdapter(mapping.dataSourceId);
        const resolved = await adapter.resolveProperties(typeName, objectId, [propertyPath]);
        return resolved.provenance.filter((p) => p.propertyPath === propertyPath);
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
          const decision = await this.policyEngine.evaluate({
            subject: identity,
            action: "invoke",
            policyName: action.authorizationPolicy,
            resource: { typeName, actionName: action.name }
          });
          results.push({ action, authorized: decision.allow });
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
        await this.requireAllowed(identity, "invoke", action.authorizationPolicy, {
          typeName: primaryType,
          actionName: action.name
        });
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
