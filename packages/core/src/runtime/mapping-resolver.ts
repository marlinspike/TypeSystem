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

  /**
   * Every property mapping for a Type, split into the required wildcard
   * `base` and zero-or-more per-property `overrides` — the shape
   * `SemanticRuntime` needs to merge a Type's properties from multiple
   * DataSources into one object read (see ADR-0023). Fails loudly on a
   * genuine misconfiguration (two mappings claiming the same field) rather
   * than silently picking one, matching this codebase's fail-closed
   * conventions elsewhere (unknown policy names, failed auth verification).
   */
  async resolvePropertyMappings(typeName: string): Promise<{ base: Mapping; overrides: Mapping[] }> {
    const propertyMappings = (await this.registry.listMappings(typeName)).filter((m) => m.target === "property");
    const base = propertyMappings.find((m) => m.targetName === "*");
    if (!base) throw new Error(`No wildcard ("*") property mapping registered for type "${typeName}"`);

    const overrides = propertyMappings.filter((m) => m.targetName !== "*");
    const seen = new Set<string>();
    for (const override of overrides) {
      if (seen.has(override.targetName)) {
        throw new Error(`Type "${typeName}" has more than one property Mapping for "${override.targetName}"`);
      }
      seen.add(override.targetName);
    }

    return { base, overrides };
  }
}
