import { ulid } from "ulid";
import type { SemanticRegistry } from "../registry/registry.js";
import { MappingResolver } from "./mapping-resolver.js";
import type { Adapter, ResolvedProperties } from "./adapter.js";
import type { Identity, PolicyEngine } from "../model/policy.js";
import type { TypeDefinition, ComputedPropertyDefinition } from "../model/type.js";
import type { ActionDefinition } from "../model/action.js";
import type { ProvenanceRef } from "../model/provenance.js";
import type { SemanticQuery, QueryResult } from "../model/query.js";
import type { ComputeContext, ActionContext } from "../model/context.js";
import { AuthorizationError, NotFoundError, PreconditionFailedError } from "./errors.js";

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
export class SemanticRuntime {
  private readonly mappingResolver: MappingResolver;
  private readonly adapters: Map<string, Adapter>;

  constructor(
    private readonly registry: SemanticRegistry,
    adapters: Adapter[],
    private readonly policyEngine: PolicyEngine
  ) {
    this.mappingResolver = new MappingResolver(registry);
    this.adapters = new Map(adapters.map((a) => [a.dataSourceId, a]));
  }

  private getAdapter(dataSourceId: string): Adapter {
    const adapter = this.adapters.get(dataSourceId);
    if (!adapter) throw new NotFoundError(`No adapter registered for data source "${dataSourceId}"`);
    return adapter;
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

    for (const cp of typeDef.computedProperties as ComputedPropertyDefinition[]) {
      computedResults[cp.name] = await cp.compute(ctx);
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
    const typeDef = await this.requireType(typeName);
    const objectPolicy = typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
    await this.requireAllowed(identity, "read", objectPolicy, { typeName, objectId });

    const mapping = await this.mappingResolver.resolvePropertyMapping(typeName);
    const adapter = this.getAdapter(mapping.dataSourceId);
    const resolved = await adapter.resolveProperties(typeName, objectId, []);

    const { values, provenance } = await this.finalizeValues(typeDef, objectId, identity, resolved);
    return { typeName, objectId, values, ...(opts.includeProvenance ? { provenance } : {}) };
  }

  async getRelationship(
    typeName: string,
    objectId: string,
    relationshipName: string,
    identity: Identity
  ): Promise<ResolvedObject[]> {
    const typeDef = await this.requireType(typeName);
    const resolvedName = this.registry.resolveAlias(typeDef, relationshipName);
    const relDef = typeDef.relationships.find((r) => r.name === resolvedName);
    if (!relDef) throw new NotFoundError(`Unknown relationship "${relationshipName}" on type "${typeName}"`);

    const propertyPolicies = typeDef.schema["x-policy"]?.propertyPolicies ?? {};
    const relPolicy = propertyPolicies[relDef.name] ?? typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
    await this.requireAllowed(identity, "read", relPolicy, { typeName, objectId, propertyPath: relDef.name });

    const adapter = this.getAdapter(relDef.resolution.dataSourceId);
    const relatedRefs = await adapter.resolveRelationship(relDef, objectId);

    const results: ResolvedObject[] = [];
    for (const ref of relatedRefs) {
      try {
        results.push(await this.getObject(relDef.targetType, ref.objectId, identity));
      } catch (err) {
        if (err instanceof AuthorizationError) continue;
        throw err;
      }
    }
    return results;
  }

  async query(q: SemanticQuery, identity: Identity): Promise<QueryResult<ResolvedObject>> {
    const typeDef = await this.requireType(q.type);
    const objectPolicy = typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
    await this.requireAllowed(identity, "read", objectPolicy, { typeName: q.type });

    const mapping = await this.mappingResolver.resolvePropertyMapping(q.type);
    const adapter = this.getAdapter(mapping.dataSourceId);
    const result = await adapter.queryByType(q.type, q.filter, q.limit, q.cursor);

    const items: ResolvedObject[] = [];
    for (const item of result.items) {
      const { values, provenance } = await this.finalizeValues(typeDef, item.objectId, identity, {
        values: item.values,
        provenance: item.provenance
      });
      const resolved: ResolvedObject = {
        typeName: q.type,
        objectId: item.objectId,
        values,
        ...(q.includeProvenance ? { provenance } : {})
      };
      if (q.include) {
        for (const inc of q.include) {
          resolved.values[inc.relationship] = await this.getRelationship(q.type, item.objectId, inc.relationship, identity);
        }
      }
      items.push(resolved);
    }
    return { items, nextCursor: result.nextCursor };
  }

  async getProvenance(
    typeName: string,
    objectId: string,
    propertyPath: string,
    identity: Identity
  ): Promise<ProvenanceRef[]> {
    const typeDef = await this.requireType(typeName);
    const propertyPolicies = typeDef.schema["x-policy"]?.propertyPolicies ?? {};
    const policyName = propertyPolicies[propertyPath] ?? typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny";
    await this.requireAllowed(identity, "read", policyName, { typeName, objectId, propertyPath });

    const computed = typeDef.computedProperties.find((c) => c.name === propertyPath);
    if (computed) {
      const nested = await Promise.all(
        computed.dependsOn.map((dep) => this.getProvenance(typeName, objectId, dep, identity))
      );
      return nested.flat();
    }

    const mapping = await this.mappingResolver.resolvePropertyMapping(typeName, propertyPath);
    const adapter = this.getAdapter(mapping.dataSourceId);
    const resolved = await adapter.resolveProperties(typeName, objectId, [propertyPath]);
    return resolved.provenance.filter((p) => p.propertyPath === propertyPath);
  }

  async listActions(typeName: string, identity: Identity): Promise<{ action: ActionDefinition; authorized: boolean }[]> {
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

  async invokeAction(actionName: string, input: unknown, identity: Identity): Promise<unknown> {
    const action = await this.registry.getAction(actionName);
    if (!action) throw new NotFoundError(`Unknown action "${actionName}"`);

    const primaryType = action.applicableTypes[0] ?? "unknown";
    await this.requireAllowed(identity, "invoke", action.authorizationPolicy, {
      typeName: primaryType,
      actionName: action.name
    });

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
}
