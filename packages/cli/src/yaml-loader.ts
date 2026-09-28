import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import type {
  SemanticRegistry,
  SemanticTypeSchema,
  RegisterTypeOptions,
  TypeDefinition,
  TraitDefinition,
  ComputeContext,
  XRelationships,
  XComputed,
  XPolicy,
  XMetadata,
  JsonSchema2020
} from "@typesys/core";

/**
 * The declarative shape a `.yaml` type file is authored in — a friendlier
 * surface over `SemanticTypeSchema`/`RegisterTypeOptions` that hides
 * `$id`/`$schema` mechanics. It compiles down to exactly the same objects
 * `registerType()` already takes; nothing about the registry or runtime
 * needed to change to support this (see the CLI package README).
 *
 * Computed-property/precondition *behavior* still can't live in YAML —
 * only `dependsOn`/`resolutionMode`/`binding` do. The real function comes
 * from `computedImplementations`, exactly like registering a type in code
 * (and exactly like `BindingRegistry` for a durable `RegistryStore` —
 * same seam, same reason: data goes in YAML/the database, behavior is
 * supplied by the process that runs it).
 */
export interface YamlTypeDocument {
  name: string;
  version: string;
  title?: string;
  description?: string;
  extends?: string;
  traits?: string[];
  properties?: Record<string, JsonSchema2020>;
  required?: string[];
  relationships?: XRelationships;
  actions?: string[];
  computed?: XComputed;
  policy?: XPolicy;
  metadata?: XMetadata;
}

export interface LoadYamlTypeOptions {
  /** Resolves `traits: [...]` names. Merge `coreTraits` with your own domain's traits. */
  traitCatalog?: Record<string, TraitDefinition>;
  /** Keyed by `computed.<prop>.binding` — the real compute functions YAML cannot carry. */
  computedImplementations?: Record<string, (ctx: ComputeContext) => Promise<unknown>>;
}

export interface LoadedYamlType {
  schema: SemanticTypeSchema;
  options: RegisterTypeOptions;
}

function typeSchemaId(name: string, version: string): string {
  return `https://typesys.dev/types/${name.replaceAll(".", "/")}/${version}`;
}

export function loadTypeYaml(yamlText: string, opts: LoadYamlTypeOptions = {}): LoadedYamlType {
  const doc = yaml.load(yamlText) as YamlTypeDocument | undefined;
  if (!doc || typeof doc !== "object") {
    throw new Error("Invalid YAML type document: expected a mapping at the top level");
  }
  if (!doc.name) throw new Error('YAML type document is missing required field "name"');
  if (!doc.version) throw new Error(`YAML type document "${doc.name}" is missing required field "version"`);

  const shortName = doc.name.includes(".") ? doc.name.slice(doc.name.lastIndexOf(".") + 1) : doc.name;

  const schema: SemanticTypeSchema = {
    $id: typeSchemaId(doc.name, doc.version),
    title: doc.title ?? shortName,
    type: "object",
    properties: doc.properties ?? {},
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.required ? { required: doc.required } : {}),
    ...(doc.relationships ? { "x-relationships": doc.relationships } : {}),
    ...(doc.actions ? { "x-actions": { actions: doc.actions } } : {}),
    ...(doc.computed ? { "x-computed": doc.computed } : {}),
    ...(doc.policy ? { "x-policy": doc.policy } : {}),
    ...(doc.metadata ? { "x-metadata": doc.metadata } : {})
  };

  const traitCatalog = opts.traitCatalog ?? {};
  const traits = (doc.traits ?? []).map((name) => {
    const trait = traitCatalog[name];
    if (!trait) {
      throw new Error(
        `Type "${doc.name}" references unknown trait "${name}" — pass it in \`traitCatalog\` ` +
          `(merge \`coreTraits\` from @typesys/core with your own domain's traits).`
      );
    }
    return trait;
  });

  const options: RegisterTypeOptions = {
    name: doc.name,
    version: doc.version,
    ...(doc.extends ? { extends: doc.extends } : {}),
    traits,
    ...(opts.computedImplementations ? { computedImplementations: opts.computedImplementations } : {})
  };

  return { schema, options };
}

export async function registerYamlType(
  registry: SemanticRegistry,
  yamlText: string,
  opts: LoadYamlTypeOptions = {}
): Promise<TypeDefinition> {
  const { schema, options } = loadTypeYaml(yamlText, opts);
  return registry.registerType(schema, options);
}

/**
 * Registers every `.yaml`/`.yml` file in `dir`, in alphabetical filename
 * order — the same "register base types before subtypes" requirement
 * `registerType` itself enforces (ADR-0004) applies here too, so name
 * files accordingly (e.g. `00-asset.yaml` before `10-aircraft.yaml`).
 */
export async function registerYamlTypesFromDirectory(
  registry: SemanticRegistry,
  dir: string,
  opts: LoadYamlTypeOptions = {}
): Promise<TypeDefinition[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  const results: TypeDefinition[] = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8");
    results.push(await registerYamlType(registry, text, opts));
  }
  return results;
}
