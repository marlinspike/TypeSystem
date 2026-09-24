import type { SemanticRegistry } from "../registry/registry.js";
import type { Mapping } from "../model/data-source.js";

/**
 * Resolves which DataSource+operation a Type's property (or a specific
 * property) is bound to. A single wildcard ("*") mapping is the common
 * case — most adapters return a whole object per call, mirroring how a
 * real REST GET or repository lookup behaves — but a Type may register a
 * more specific per-property Mapping that takes precedence.
 */
export class MappingResolver {
  constructor(private readonly registry: SemanticRegistry) {}

  async resolvePropertyMapping(typeName: string, propertyName?: string): Promise<Mapping> {
    const mappings = await this.registry.listMappings(typeName);
    const propertyMappings = mappings.filter((m) => m.target === "property");
    const specific = propertyName ? propertyMappings.find((m) => m.targetName === propertyName) : undefined;
    const wildcard = propertyMappings.find((m) => m.targetName === "*");
    const mapping = specific ?? wildcard;
    if (!mapping) {
      throw new Error(`No property mapping registered for type "${typeName}"`);
    }
    return mapping;
  }
}
