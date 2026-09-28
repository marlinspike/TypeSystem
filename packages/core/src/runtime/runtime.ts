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
import type { SemanticQuery, QueryInclude, QueryResult } from "../model/query.js";
import type { ComputeContext, ActionContext } from "../model/context.js";
import { InputValidator, type QueryLimits } from "./input-validation.js";
import { AuthorizationError, NotFoundError, PreconditionFailedError, RateLimitExceededError } from "./errors.js";
import { type Cache, NoopCache } from "./cache.js";
import { type RateLimiter, NoopRateLimiter } from "./rate-limiter.js";
import { mapWithConcurrency, mapWithConcurrencySettled } from "./concurrency.js";
import { matchesFilter } from "./filter.js";
import { instrumentOperation, annotateActiveSpan } from "../observability/tracing.js";
import { recordPolicyDecision, recordCacheResult } from "../observability/metrics.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 20;

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
  /** Caps how many adapter calls a single relationship/query/provenance fan-out issues concurrently (see ADR-0019 and `mapWithConcurrency`). Default 20. */
  maxConcurrency?: number;
  /** Overrides for any of `DEFAULT_QUERY_LIMITS` — page size, include count and depth, filter depth/size (see `input-validation.ts`). */
  queryLimits?: Partial<QueryLimits>;
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
    this.mappingResolver = new MappingResolver(registry);
    this.adapters = new Map(adapters.map((a) => [a.dataSourceId, a]));
  }

  /** The effective query bounds — what a transport should advertise (e.g. the MCP `query` tool's inputSchema). */
  get queryLimits(): QueryLimits {
    return this.inputValidator.limits;
  }

  private getAdapter(dataSourceId: string): Adapter {
    const adapter = this.adapters.get(dataSourceId);
    if (!adapter) throw new NotFoundError(`No adapter registered for data source "${dataSourceId}"`);
    return adapter;
  }

  private checkRateLimit(identity: Identity): void {
    if (!this.rateLimiter.tryAcquire(identity.subjectId)) {
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
    return instrumentOperation(
      "SemanticRuntime.getObject",
      typeName,
      { "typesys.object_id": objectId, "typesys.identity.subject_id": identity.subjectId },
      async () => {
        this.checkRateLimit(identity);
        const typeDef = await this.requireType(typeName);
        const objectPolicy = typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
        await this.requireAllowed(identity, "read", objectPolicy, { typeName, objectId });

        const resolved = await this.resolveObjectProperties(typeName, objectId);

        const { values, provenance } = await this.finalizeValues(typeDef, objectId, identity, resolved);
        return { typeName, objectId, values, ...(opts.includeProvenance ? { provenance } : {}) };
      }
    );
  }

  async getRelationship(
    typeName: string,
    objectId: string,
    relationshipName: string,
    identity: Identity
  ): Promise<ResolvedObject[]> {
    return instrumentOperation(
      "SemanticRuntime.getRelationship",
      typeName,
      { "typesys.object_id": objectId, "typesys.relationship_name": relationshipName, "typesys.identity.subject_id": identity.subjectId },
      async () => {
        this.checkRateLimit(identity);
        const typeDef = await this.requireType(typeName);
        const resolvedName = this.registry.resolveAlias(typeDef, relationshipName);
        const relDef = typeDef.relationships.find((r) => r.name === resolvedName);
        if (!relDef) throw new NotFoundError(`Unknown relationship "${relationshipName}" on type "${typeName}"`);

        const propertyPolicies = typeDef.schema["x-policy"]?.propertyPolicies ?? {};
        const relPolicy = propertyPolicies[relDef.name] ?? typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
        await this.requireAllowed(identity, "read", relPolicy, { typeName, objectId, propertyPath: relDef.name });

        const adapter = this.getAdapter(relDef.resolution.dataSourceId);
        const relatedRefs = await this.resolveRelationship(adapter, relDef, objectId);

        // Fan out concurrently, not one sequential round trip per related object — the
        // classic N+1 pattern for a one-to-many relationship (e.g. an Aircraft with 50
        // components previously meant 50 sequential getObject calls). Bounded by
        // maxConcurrency (ADR-0019) rather than a raw Promise.allSettled, so a relationship
        // with thousands of related objects can't open thousands of simultaneous adapter
        // calls at once; still preserves relatedRefs order and still lets an unauthorized
        // related object be silently omitted (ADR's existing behavior) without an early
        // return aborting the rest of a partially-authorized batch.
        const settled = await mapWithConcurrencySettled(relatedRefs, this.maxConcurrency, (ref) =>
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
    );
  }

  /**
   * `input` is validated against `semanticQuerySchema` and the runtime's
   * `QueryLimits` before anything else runs — callers (an MCP tool, an HTTP
   * body) routinely hand this unchecked JSON. An omitted `limit` becomes
   * `queryLimits.defaultLimit`; follow `nextCursor` for further pages.
   */
  async query(input: SemanticQuery, identity: Identity): Promise<QueryResult<ResolvedObject>> {
    const claimedType = (input as { type?: unknown } | null | undefined)?.type;
    return instrumentOperation(
      "SemanticRuntime.query",
      typeof claimedType === "string" ? claimedType : "unknown",
      { "typesys.identity.subject_id": identity.subjectId },
      async () => {
        this.checkRateLimit(identity);
        const q = this.inputValidator.validateQuery(input);
        annotateActiveSpan({ "typesys.query.limit": q.limit });
        const typeDef = await this.requireType(q.type);
        const objectPolicy = typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
        await this.requireAllowed(identity, "read", objectPolicy, { typeName: q.type });

        // Listing/filtering/pagination is inherently single-source — only the base
        // mapping's adapter can answer "which objects match", so overrides (ADR-0023)
        // are merged per item below, not folded into this call.
        const { base, overrides } = await this.mappingResolver.resolvePropertyMappings(q.type);
        const adapter = this.getAdapter(base.dataSourceId);
        const result = await adapter.queryByType(q.type, q.filter, q.limit, q.cursor);

        // Every item, and every `include` within an item, is independent — resolve the
        // whole O(items x includes) fan-out concurrently rather than one sequential
        // round trip at a time (the same N+1 pattern fixed in getRelationship above,
        // multiplied across a whole result page), bounded by maxConcurrency (ADR-0019)
        // so a large `limit` can't open unbounded concurrent adapter calls.
        const items = await mapWithConcurrency(result.items, this.maxConcurrency, async (item) => {
          const merged = await this.mergeOverrides(q.type, item.objectId, { values: item.values, provenance: item.provenance }, overrides);
          const { values, provenance } = await this.finalizeValues(typeDef, item.objectId, identity, merged);
          const resolved: ResolvedObject = {
            typeName: q.type,
            objectId: item.objectId,
            values,
            ...(q.includeProvenance ? { provenance } : {})
          };
          if (q.include) {
            Object.assign(resolved.values, await this.resolveIncludes(q.type, item.objectId, q.include, identity));
          }
          return resolved;
        });
        return { items, nextCursor: result.nextCursor };
      }
    );
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
      const kept = inc.filter ? related.filter((r) => matchesFilter(r.values, inc.filter)) : related;
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
    return instrumentOperation(
      "SemanticRuntime.getProvenance",
      typeName,
      { "typesys.object_id": objectId, "typesys.property_path": propertyPath, "typesys.identity.subject_id": identity.subjectId },
      async () => {
        this.checkRateLimit(identity);
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
    );
  }

  async listActions(typeName: string, identity: Identity): Promise<{ action: ActionDefinition; authorized: boolean }[]> {
    return instrumentOperation(
      "SemanticRuntime.listActions",
      typeName,
      { "typesys.identity.subject_id": identity.subjectId },
      async () => {
        this.checkRateLimit(identity);
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
    );
  }

  async invokeAction(actionName: string, input: unknown, identity: Identity): Promise<unknown> {
    const action = await this.registry.getAction(actionName);
    if (!action) throw new NotFoundError(`Unknown action "${actionName}"`);
    const primaryType = action.applicableTypes[0] ?? "unknown";

    return instrumentOperation(
      "SemanticRuntime.invokeAction",
      primaryType,
      { "typesys.action_name": action.name, "typesys.identity.subject_id": identity.subjectId },
      async () => {
        this.checkRateLimit(identity);
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
    );
  }
}
