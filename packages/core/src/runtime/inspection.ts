import { createHash } from "node:crypto";
import type { ActionDefinition } from "../model/action.js";
import { canonical } from "../model/canonical.js";
import type { DataSource, Mapping, ResolutionMode } from "../model/data-source.js";
import type { JsonSchema2020 } from "../model/json-schema.js";
import type { TypeDefinition } from "../model/type.js";
import type { Cardinality } from "../model/vocabulary.js";
import type { ModelDescription } from "../registry/model-description.js";
import type { SemanticRegistry } from "../registry/registry.js";

export const INSPECTION_FORMAT = "typesys.inspection/1";

/**
 * Who may inspect the enforcement structure (ADR-0088). The named policy is
 * decided by the runtime's own engine, with action `read` on
 * `{ typeName: "*", actionName: "inspect-model" }`, and audited like any
 * other decision. With no inspection configured, nobody may inspect.
 */
export interface InspectionOptions {
  readonly policy: string;
}

/** Where a stored value is read from: the Type's own mapping, or a per-property override to another source (ADR-0023). */
export interface MemberSource {
  readonly dataSourceId: string;
  readonly operation: string;
  readonly resolutionMode: ResolutionMode;
  /** A per-property mapping overrides the Type's wildcard one for this value. */
  readonly override: boolean;
}

/** The markings on something, as far as the inspector is cleared to learn them. */
export interface InspectedMarkings {
  /** Markings the inspector is cleared for, by name. */
  readonly markings: readonly string[];
  /** How many more markings there are that the inspector is not cleared to learn the names of (ADR-0032). */
  readonly withheldMarkings?: number;
}

export interface MemberInspection extends InspectedMarkings {
  readonly name: string;
  readonly kind: "stored" | "computed";
  /** Where the composed Type got the member: its own schema, a trait, or the Type it extends (ADR-0004). */
  readonly origin: { readonly from: "own" } | { readonly from: "trait"; readonly name: string } | { readonly from: "base"; readonly type: string };
  readonly schema?: JsonSchema2020;
  readonly required: boolean;
  /** For a stored value. */
  readonly source?: MemberSource;
  /** The member's own read policy, which narrows the object policy (ADR-0030). */
  readonly policy?: string;
  /** The system of record the domain author names for it (`x-provenance.properties[...].authoritativeSource`). */
  readonly authoritativeSource?: string;
  /** For a computed value (ADR-0022, ADR-0052). */
  readonly computed?: {
    readonly dependsOn: readonly string[];
    /** Inputs whose read policy this value is released from; markings are never released. */
    readonly releases: readonly string[];
    /** Sources the computation reads directly, enforced by the runtime; `undeclared` when the definition does not say, so it may read any. */
    readonly reads: readonly string[] | "undeclared";
    readonly binding: string;
    readonly resolutionMode: ResolutionMode;
  };
}

export interface RelationshipInspection extends InspectedMarkings {
  readonly name: string;
  readonly target: string;
  readonly cardinality: Cardinality;
  readonly optional: boolean;
  readonly source: { readonly dataSourceId: string; readonly operation: string; readonly resolutionMode: ResolutionMode };
  /** Resolved through a different source than the one the Type's own values come from. */
  readonly crossSource: boolean;
  readonly policy?: string;
}

export interface TypeInspection extends InspectedMarkings {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly extends?: string;
  readonly traits: readonly string[];
  /** The object-level read policy every read of it is decided by. */
  readonly objectPolicy: string;
  /** The source the Type's own values come from (its wildcard mapping), when it has one. */
  readonly source?: { readonly dataSourceId: string; readonly operation: string; readonly resolutionMode: ResolutionMode };
  readonly members: readonly MemberInspection[];
  readonly relationships: readonly RelationshipInspection[];
  readonly actions: readonly string[];
  readonly deprecated?: { readonly since: string; readonly supersededBy?: string; readonly sunsetAt?: string };
}

export interface ActionInspection extends InspectedMarkings {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly applicableTypes: readonly string[];
  /** The Type an instance-scoped Action acts on and the input naming it (ADR-0053). */
  readonly target?: { readonly type: string; readonly idFrom: string };
  readonly outputType?: string;
  readonly policy: string;
  readonly preconditions: readonly { readonly description: string }[];
  /** The source system the Action's effect lands in, and the operation it calls there. */
  readonly implementation: { readonly dataSourceId: string; readonly operation: string };
  readonly sideEffects: ActionDefinition["sideEffects"];
  readonly idempotency: ActionDefinition["idempotency"];
  readonly auditRequired: boolean;
  readonly inputSchema: JsonSchema2020;
  readonly outputSchema: JsonSchema2020;
}

/** A source system, without its configuration, which can hold credentials. */
export interface SourceInspection {
  readonly id: string;
  readonly name?: string;
  readonly kind?: string;
  /** Whether the runtime has an adapter for it. */
  readonly connected: boolean;
}

export interface PolicyInspection {
  readonly name: string;
  /**
   * The rule's structure, as its engine describes it (`PolicyEngine.describe`):
   * `role in [maintainer, ai-enclave]`. Absent when the engine cannot
   * describe it, which `opaque` says.
   */
  readonly rule?: string;
  readonly opaque: boolean;
  /** What the policy decides: `Type`, `Type.member`, or an Action's name. */
  readonly decides: readonly string[];
}

/**
 * The enforcement structure of the part of the model an inspector may
 * learn of (ADR-0088): where each value comes from, which policy and
 * marking guards it, what each computed value is derived from and released
 * from, which source each Action writes to. It describes definitions, never
 * data, and decides nothing: the runtime still decides every read and
 * invocation.
 */
export interface ModelInspection {
  readonly format: typeof INSPECTION_FORMAT;
  /**
   * sha256 of everything else in this inspection: the same model inspected
   * by the same inspector gives the same digest, so a context or a graph
   * built on it names the model it describes. Computed over what the
   * inspector is shown only, so it never changes with something withheld.
   */
  readonly modelDigest: string;
  readonly classificationScheme: string;
  readonly types: readonly TypeInspection[];
  readonly actions: readonly ActionInspection[];
  readonly sources: readonly SourceInspection[];
  readonly policies: readonly PolicyInspection[];
  /**
   * Whether the inspector's discovery narrows what is described (ADR-0068).
   * Under need-to-know what they may not learn of is neither described nor
   * counted: a count would say that something exists.
   */
  readonly narrowed: boolean;
}

/** What building an inspection asks of the runtime, each decided for the inspector. */
export interface InspectionGate {
  /** Whether the inspector is cleared to learn this marking's name. */
  markingKnowable(marking: string): boolean;
  /** The engine's description of a policy, if it has one. */
  describePolicy(policyName: string): Promise<string | undefined>;
  /** Whether a source has an adapter. */
  connected(dataSourceId: string): boolean;
}

function markingsFor(markings: readonly string[], gate: InspectionGate): InspectedMarkings {
  const known = markings.filter((m) => gate.markingKnowable(m));
  return { markings: known, ...(known.length < markings.length ? { withheldMarkings: markings.length - known.length } : {}) };
}

/** Each composed property's origin, as `describeModel` composes them: base, then traits, then own, the later winning. */
async function origins(registry: SemanticRegistry, typeDef: TypeDefinition): Promise<Map<string, MemberInspection["origin"]>> {
  const base = typeDef.extends ? await registry.getType(typeDef.extends) : undefined;
  const result = base ? new Map([...(await origins(registry, base))].map(([k, v]) => [k, v.from === "own" ? ({ from: "base", type: base.name } as const) : v])) : new Map<string, MemberInspection["origin"]>();
  for (const trait of typeDef.traits ?? []) for (const name of Object.keys(registry.getTraitSchema(trait)?.properties ?? {})) result.set(name, { from: "trait", name: trait });
  for (const name of Object.keys(typeDef.schema.properties ?? {})) result.set(name, { from: "own" });
  return result;
}

/**
 * The inspection of `described`: the model as the inspector may learn of it
 * (`describeModel`'s answer for them), with the enforcement structure of each
 * Type, member and Action in it filled in from the registry's definitions.
 * Nothing the description withholds is named.
 */
export async function buildInspection(
  registry: SemanticRegistry,
  described: ModelDescription,
  narrowed: boolean,
  gate: InspectionGate,
  classificationScheme: string
): Promise<ModelInspection> {
  const decides = new Map<string, Set<string>>();
  const decided = (policy: string, what: string) => (decides.get(policy) ?? decides.set(policy, new Set()).get(policy)!).add(what);
  const sourceIds = new Set<string>();

  const types: TypeInspection[] = [];
  for (const t of described.types) {
    const def = (await registry.getType(t.name))!;
    const xpol = def.schema["x-policy"];
    const xprov = def.schema["x-provenance"];
    const mappings: Mapping[] = (await registry.listMappings(t.name)).filter((m) => m.target === "property");
    const wildcard = mappings.find((m) => m.targetName === "*");
    const overrides = new Map(mappings.filter((m) => m.targetName !== "*").map((m) => [m.targetName, m]));
    if (wildcard) sourceIds.add(wildcard.dataSourceId);
    const from = await origins(registry, def);
    const required = new Set(t.required);
    const objectPolicy = xpol?.objectPolicy ?? "default-deny";
    decided(objectPolicy, t.name);
    const memberMarkings = (name: string) => {
      const m = xprov?.properties && Object.hasOwn(xprov.properties, name) ? xprov.properties[name]?.classification : undefined;
      return m === undefined ? [] : [m];
    };
    const memberPolicy = (name: string) => (xpol?.propertyPolicies && Object.hasOwn(xpol.propertyPolicies, name) ? xpol.propertyPolicies[name] : undefined);

    const members: MemberInspection[] = [];
    for (const [name, schema] of Object.entries(t.properties)) {
      const mapping = overrides.get(name) ?? wildcard;
      if (mapping) sourceIds.add(mapping.dataSourceId);
      const policy = memberPolicy(name);
      if (policy) decided(policy, `${t.name}.${name}`);
      const authoritative = xprov?.properties?.[name]?.authoritativeSource;
      members.push({
        name,
        kind: "stored",
        origin: from.get(name) ?? { from: "own" },
        schema,
        required: required.has(name),
        ...(mapping ? { source: { dataSourceId: mapping.dataSourceId, operation: mapping.operation, resolutionMode: mapping.resolutionMode, override: mapping !== wildcard } } : {}),
        ...(policy ? { policy } : {}),
        ...(authoritative ? { authoritativeSource: authoritative } : {}),
        ...markingsFor(memberMarkings(name), gate)
      });
    }
    for (const c of t.computed) {
      const cp = def.computedProperties.find((x) => x.name === c.name)!;
      for (const id of cp.reads ?? []) sourceIds.add(id);
      const policy = memberPolicy(c.name);
      if (policy) decided(policy, `${t.name}.${c.name}`);
      members.push({
        name: c.name,
        kind: "computed",
        origin: { from: "own" },
        ...(c.schema ? { schema: c.schema } : {}),
        required: false,
        ...(policy ? { policy } : {}),
        // The description already dropped any input the inspector may not learn of; a release of one is dropped with it.
        computed: { dependsOn: c.dependsOn, releases: (cp.releases ?? []).filter((r) => c.dependsOn.includes(r)), reads: cp.reads ? [...cp.reads] : "undeclared", binding: cp.binding, resolutionMode: cp.resolutionMode },
        ...markingsFor(memberMarkings(c.name), gate)
      });
    }

    const relationships: RelationshipInspection[] = t.relationships.map((r) => {
      const rel = def.relationships.find((x) => x.name === r.name)!;
      sourceIds.add(rel.resolution.dataSourceId);
      const policy = memberPolicy(r.name);
      if (policy) decided(policy, `${t.name}.${r.name}`);
      return {
        name: r.name,
        target: r.target,
        cardinality: r.cardinality,
        optional: rel.optional === true,
        source: { dataSourceId: rel.resolution.dataSourceId, operation: rel.resolution.operation, resolutionMode: rel.resolutionMode ?? "live" },
        crossSource: wildcard !== undefined && rel.resolution.dataSourceId !== wildcard.dataSourceId,
        ...(policy ? { policy } : {}),
        ...markingsFor(memberMarkings(r.name), gate)
      };
    });

    const objectMarking = xprov?.defaultClassification;
    types.push({
      name: t.name,
      version: t.version,
      ...(t.description ? { description: t.description } : {}),
      ...(t.extends ? { extends: t.extends } : {}),
      traits: t.traits,
      objectPolicy,
      ...(wildcard ? { source: { dataSourceId: wildcard.dataSourceId, operation: wildcard.operation, resolutionMode: wildcard.resolutionMode } } : {}),
      members,
      relationships,
      actions: t.actions,
      ...(t.deprecated ? { deprecated: t.deprecated } : {}),
      ...markingsFor(objectMarking === undefined ? [] : [objectMarking], gate)
    });
  }

  const typeMarkings = new Map<string, string[]>();
  for (const t of await registry.listTypes()) {
    const m = t.schema["x-provenance"]?.defaultClassification;
    typeMarkings.set(t.name, m === undefined ? [] : [m]);
  }
  const actions: ActionInspection[] = [];
  for (const a of described.actions) {
    const def = (await registry.getAction(a.name))!;
    sourceIds.add(def.implementation.dataSourceId);
    decided(def.authorizationPolicy, a.name);
    actions.push({
      name: a.name,
      version: a.version,
      description: a.description,
      applicableTypes: a.applicableTypes,
      ...(a.target ? { target: a.target } : {}),
      ...(def.outputType && described.types.some((t) => t.name === def.outputType) ? { outputType: def.outputType } : {}),
      policy: def.authorizationPolicy,
      preconditions: (def.preconditions ?? []).map((p) => ({ description: p.description })),
      implementation: { dataSourceId: def.implementation.dataSourceId, operation: def.implementation.operation },
      sideEffects: def.sideEffects,
      idempotency: def.idempotency,
      auditRequired: def.auditRequired,
      inputSchema: a.inputSchema,
      outputSchema: a.outputSchema,
      ...markingsFor([...new Set(def.applicableTypes.flatMap((n) => typeMarkings.get(n) ?? []))], gate)
    });
  }

  const sources: SourceInspection[] = [];
  for (const id of [...sourceIds].sort()) {
    const ds: DataSource | undefined = await registry.getDataSource(id);
    sources.push({ id, ...(ds?.name ? { name: ds.name } : {}), ...(ds?.kind ? { kind: ds.kind } : {}), connected: gate.connected(id) });
  }

  const policies: PolicyInspection[] = [];
  for (const [name, what] of [...decides].sort(([a], [b]) => a.localeCompare(b))) {
    const rule = await gate.describePolicy(name);
    policies.push({ name, ...(rule !== undefined ? { rule } : {}), opaque: rule === undefined, decides: [...what].sort() });
  }

  const body = { classificationScheme, types, actions, sources, policies, narrowed };
  return { format: INSPECTION_FORMAT, modelDigest: `sha256:${createHash("sha256").update(canonical(body)).digest("hex")}`, ...body };
}
