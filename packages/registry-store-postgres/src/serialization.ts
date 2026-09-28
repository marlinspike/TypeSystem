import { MissingBindingError, type BindingRegistry } from "@typesys/core";
import type { TypeDefinition, ComputedPropertyDefinition } from "@typesys/core";
import type { ActionDefinition, PreconditionSpec } from "@typesys/core";
import type { RelationshipDefinition } from "@typesys/core";
import type { DataSource, Mapping } from "@typesys/core";
import type { AuditEvent } from "@typesys/core";

/** Postgres round-trips `null`, not `undefined`; normalize before binding query params. */
export function toJsonParam(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Computed properties — strip `compute` on write, re-attach it on read via
// the caller-supplied BindingRegistry (see ADR-0015).
// ---------------------------------------------------------------------------

export interface PersistedComputedProperty {
  name: string;
  dependsOn: string[];
  resolutionMode: "live" | "materialized" | "cached";
  binding: string;
}

export function computedPropertiesToPersisted(cps: ComputedPropertyDefinition[]): PersistedComputedProperty[] {
  return cps.map((cp) => {
    if (!cp.binding) {
      throw new Error(
        `Computed property "${cp.name}" has no binding — cannot persist it to Postgres. ` +
          `Every ComputedPropertyDefinition written to a durable RegistryStore must carry the ` +
          `"binding" key it was registered under (see ADR-0015).`
      );
    }
    return { name: cp.name, dependsOn: cp.dependsOn, resolutionMode: cp.resolutionMode, binding: cp.binding };
  });
}

export function persistedToComputedProperties(
  persisted: PersistedComputedProperty[],
  bindings: BindingRegistry,
  context: string
): ComputedPropertyDefinition[] {
  return persisted.map((p) => {
    const compute = bindings.computed[p.binding];
    if (!compute) throw new MissingBindingError("computed", p.binding, context);
    return { name: p.name, dependsOn: p.dependsOn, resolutionMode: p.resolutionMode, binding: p.binding, compute };
  });
}

// ---------------------------------------------------------------------------
// Preconditions — same shape of problem as computed properties.
// ---------------------------------------------------------------------------

export interface PersistedPrecondition {
  description: string;
  bindingId: string;
}

export function preconditionsToPersisted(preconditions: PreconditionSpec[] | undefined): PersistedPrecondition[] {
  return (preconditions ?? []).map((p) => {
    if (!p.bindingId) {
      throw new Error(
        `Precondition "${p.description}" has no bindingId — cannot persist it to Postgres. ` +
          `Every PreconditionSpec written to a durable RegistryStore must carry a "bindingId" (see ADR-0015).`
      );
    }
    return { description: p.description, bindingId: p.bindingId };
  });
}

export function persistedToPreconditions(
  persisted: PersistedPrecondition[],
  bindings: BindingRegistry,
  context: string
): PreconditionSpec[] {
  return persisted.map((p) => {
    const check = bindings.preconditions[p.bindingId];
    if (!check) throw new MissingBindingError("precondition", p.bindingId, context);
    return { description: p.description, bindingId: p.bindingId, check };
  });
}

// ---------------------------------------------------------------------------
// Row shapes (snake_case, as returned by `pg`)
// ---------------------------------------------------------------------------

export interface TypeRow {
  id: string;
  name: string;
  version: string;
  extends: string | null;
  traits: string[];
  description: string | null;
  schema: TypeDefinition["schema"];
  action_names: string[];
  computed_properties: PersistedComputedProperty[];
  deprecated: TypeDefinition["deprecated"] | null;
  aliases: Record<string, string> | null;
}

export function typeRowToDefinition(
  row: TypeRow,
  relationships: TypeDefinition["relationships"],
  bindings: BindingRegistry
): TypeDefinition {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    extends: row.extends ?? undefined,
    traits: row.traits,
    description: row.description ?? undefined,
    schema: row.schema,
    relationships,
    actionNames: row.action_names,
    computedProperties: persistedToComputedProperties(row.computed_properties, bindings, `type "${row.name}@${row.version}"`),
    deprecated: row.deprecated ?? undefined,
    aliases: row.aliases ?? undefined
  };
}

export interface ActionRow {
  id: string;
  name: string;
  version: string;
  description: string;
  applicable_types: string[];
  input_schema: ActionDefinition["inputSchema"];
  output_schema: ActionDefinition["outputSchema"];
  authorization_policy: string;
  preconditions: PersistedPrecondition[];
  implementation: ActionDefinition["implementation"];
  side_effects: ActionDefinition["sideEffects"];
  idempotency: ActionDefinition["idempotency"];
  audit_required: boolean;
  deprecated: ActionDefinition["deprecated"] | null;
}

export function actionRowToDefinition(row: ActionRow, bindings: BindingRegistry): ActionDefinition {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    applicableTypes: row.applicable_types,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    authorizationPolicy: row.authorization_policy,
    preconditions: persistedToPreconditions(row.preconditions, bindings, `action "${row.name}@${row.version}"`),
    implementation: row.implementation,
    sideEffects: row.side_effects,
    idempotency: row.idempotency,
    auditRequired: row.audit_required,
    deprecated: row.deprecated ?? undefined
  };
}

export interface RelationshipRow {
  id: string;
  name: string;
  source_type: string;
  target_type: string;
  cardinality: RelationshipDefinition["cardinality"];
  inverse_name: string | null;
  edge_schema: RelationshipDefinition["edgeSchema"] | null;
  resolution: RelationshipDefinition["resolution"];
  version: string;
  deprecated: RelationshipDefinition["deprecated"] | null;
}

export function relationshipRowToDefinition(row: RelationshipRow): RelationshipDefinition {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    targetType: row.target_type,
    cardinality: row.cardinality,
    inverseName: row.inverse_name ?? undefined,
    edgeSchema: row.edge_schema ?? undefined,
    resolution: row.resolution,
    version: row.version,
    deprecated: row.deprecated ?? undefined
  };
}

export interface DataSourceRow {
  id: string;
  name: string;
  kind: string;
  config: Record<string, unknown> | null;
}

export function dataSourceRowToDefinition(row: DataSourceRow): DataSource {
  return { id: row.id, name: row.name, kind: row.kind, config: row.config ?? undefined };
}

export interface MappingRow {
  id: string;
  type_name: string;
  target: Mapping["target"];
  target_name: string;
  data_source_id: string;
  operation: string;
  resolution_mode: Mapping["resolutionMode"];
  priority: number | null;
}

export function mappingRowToDefinition(row: MappingRow): Mapping {
  return {
    id: row.id,
    typeName: row.type_name,
    target: row.target,
    targetName: row.target_name,
    dataSourceId: row.data_source_id,
    operation: row.operation,
    resolutionMode: row.resolution_mode,
    priority: row.priority ?? undefined
  };
}

export interface AuditEventRow {
  id: string;
  timestamp: string;
  subject_id: string;
  action: string;
  resource_type_name: string;
  resource_object_id: string | null;
  resource_property_path: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  outcome: "success" | "failure" | null;
  details: Record<string, unknown> | null;
}

export function auditEventRowToEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    subjectId: row.subject_id,
    action: row.action,
    resource: {
      typeName: row.resource_type_name,
      objectId: row.resource_object_id ?? undefined,
      propertyPath: row.resource_property_path ?? undefined
    },
    decision: row.decision,
    reason: row.reason ?? undefined,
    outcome: row.outcome ?? undefined,
    details: row.details ?? undefined
  };
}
