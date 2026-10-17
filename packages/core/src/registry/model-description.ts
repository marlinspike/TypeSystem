import type { JsonSchema2020 } from "../model/json-schema.js";
import type { ActionDefinition } from "../model/action.js";
import type { Cardinality } from "../model/vocabulary.js";
import type { TypeDefinition } from "../model/type.js";
import type { SemanticRegistry } from "./registry.js";

/**
 * The model as a consumer sees it (ADR-0056): each Type with its `extends`
 * and traits already composed (ADR-0004), as plain, serializable JSON. It is
 * what a typed client is generated from (ADR-0055), what an agent discovers
 * from, and what two versions of a model are compared by. It carries the
 * contract and nothing about enforcement: no policy names, mappings, data
 * sources or bindings, which are the runtime's business.
 */
export interface ModelDescription {
  format: "typesys.model/1";
  types: TypeDescription[];
  actions: ActionDescription[];
}

export interface TypeDescription {
  name: string;
  version: string;
  description?: string;
  extends?: string;
  traits: string[];
  /** Stored properties, base then traits then own (the later winning), as the registry composed them. */
  properties: Record<string, JsonSchema2020>;
  required: string[];
  computed: { name: string; dependsOn: string[]; schema?: JsonSchema2020 }[];
  relationships: { name: string; target: string; cardinality: Cardinality; optional?: true }[];
  /** The Actions that apply to this Type. */
  actions: string[];
  deprecated?: { since: string; supersededBy?: string; sunsetAt?: string };
  /** Old property or relationship name to its current one, accepted during a transition (ADR-0010). */
  aliases?: Record<string, string>;
}

export interface ActionDescription {
  name: string;
  version: string;
  description: string;
  applicableTypes: string[];
  inputSchema: JsonSchema2020;
  outputSchema: JsonSchema2020;
  /** The Type an instance-scoped Action acts on, and the input property carrying its id (ADR-0053). */
  target?: { type: string; idFrom: string };
  sideEffects: ActionDefinition["sideEffects"];
  idempotency: ActionDefinition["idempotency"];
  deprecated?: { since: string; supersededBy?: string };
}

export interface DescribeModelOptions {
  /** Only Types whose names start with one of these (and the Actions on them), plus every Type their relationships reach, so each target is described. */
  prefixes?: string[];
}

/** A Type's stored properties as the registry composes them: its base's, then its traits', then its own. */
export async function composedProperties(registry: SemanticRegistry, typeDef: TypeDefinition): Promise<{ properties: Record<string, JsonSchema2020>; required: Set<string> }> {
  const base = typeDef.extends ? await registry.getType(typeDef.extends) : undefined;
  const { properties, required } = base ? await composedProperties(registry, base) : { properties: {}, required: new Set<string>() };
  for (const trait of typeDef.traits ?? []) {
    const schema = registry.getTraitSchema(trait);
    Object.assign(properties, schema?.properties ?? {});
    for (const r of schema?.required ?? []) required.add(r);
  }
  Object.assign(properties, typeDef.schema.properties ?? {});
  for (const r of typeDef.schema.required ?? []) required.add(r);
  return { properties, required };
}

/** The selected Types and every Type their relationships reach, transitively. */
function closure(all: TypeDefinition[], prefixes: string[] | undefined): TypeDefinition[] {
  const byName = new Map(all.map((t) => [t.name, t]));
  const keep = new Set<string>();
  const stack = (prefixes ? all.filter((t) => prefixes.some((p) => t.name.startsWith(p))) : all).map((t) => t.name);
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (keep.has(name)) continue;
    keep.add(name);
    for (const rel of byName.get(name)?.relationships ?? []) if (byName.has(rel.targetType)) stack.push(rel.targetType);
  }
  return all.filter((t) => keep.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
}

export function describeAction(action: ActionDefinition): ActionDescription {
  return {
    name: action.name,
    version: action.version,
    description: action.description,
    applicableTypes: [...action.applicableTypes],
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    ...(action.target ? { target: { type: action.target.type ?? action.applicableTypes[0]!, idFrom: action.target.idFrom } } : {}),
    sideEffects: action.sideEffects,
    idempotency: action.idempotency,
    ...(action.deprecated ? { deprecated: action.deprecated } : {})
  };
}

/** The registry's current model, sorted by name so two descriptions of the same model are byte-identical. */
export async function describeModel(registry: SemanticRegistry, opts: DescribeModelOptions = {}): Promise<ModelDescription> {
  const typeDefs = closure(await registry.listTypes(), opts.prefixes);
  const names = new Set(typeDefs.map((t) => t.name));
  const selected = (t: string) => names.has(t) && (!opts.prefixes || opts.prefixes.some((p) => t.startsWith(p)));
  const actions = (await registry.listActions()).filter((a) => a.applicableTypes.some(selected)).sort((a, b) => a.name.localeCompare(b.name));

  const types = await Promise.all(
    typeDefs.map(async (t): Promise<TypeDescription> => {
      const { properties, required } = await composedProperties(registry, t);
      return {
        name: t.name,
        version: t.version,
        ...(t.description ? { description: t.description } : {}),
        ...(t.extends ? { extends: t.extends } : {}),
        traits: [...(t.traits ?? [])],
        properties,
        required: [...required].filter((r) => r in properties).sort(),
        computed: t.computedProperties.map((cp) => ({ name: cp.name, dependsOn: [...cp.dependsOn], ...(cp.schema ? { schema: cp.schema } : {}) })),
        relationships: t.relationships.map((r) => ({ name: r.name, target: r.targetType, cardinality: r.cardinality, ...(r.optional ? { optional: true as const } : {}) })),
        actions: actions.filter((a) => a.applicableTypes.includes(t.name)).map((a) => a.name),
        ...(t.deprecated ? { deprecated: t.deprecated } : {}),
        ...(t.aliases && Object.keys(t.aliases).length > 0 ? { aliases: { ...t.aliases } } : {})
      };
    })
  );
  return { format: "typesys.model/1", types, actions: actions.map(describeAction) };
}
