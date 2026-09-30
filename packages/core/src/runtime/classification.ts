import type { TypeDefinition } from "../model/type.js";

/**
 * How clearances compare to classification markings (ADR-0032). The
 * runtime asks only `dominates`, so an ordered list (`linearClassification`)
 * and a lattice with compartments or caveats plug in the same way.
 */
export interface ClassificationScheme {
  /**
   * Whether a subject holding `clearance` (none: `undefined`) may read data
   * marked `marking`. Must be `false` for a marking the scheme doesn't
   * recognize, so a typo or a foreign label is readable by no one.
   */
  dominates(clearance: string | undefined, marking: string): boolean;
}

/**
 * The usual ordered scheme, lowest level first. A missing or unrecognized
 * clearance holds only the lowest level; an unrecognized marking is
 * dominated by no clearance. Markings compare as exact strings.
 */
export function linearClassification(levels: readonly string[]): ClassificationScheme {
  if (levels.length === 0) throw new TypeError("linearClassification() needs at least one level");
  const rank = new Map(levels.map((level, i) => [level, i]));
  if (rank.size !== levels.length) throw new TypeError("linearClassification() levels must be distinct");
  return {
    dominates(clearance, marking) {
      const required = rank.get(marking);
      if (required === undefined) return false;
      const held = (clearance === undefined ? undefined : rank.get(clearance)) ?? 0;
      return held >= required;
    }
  };
}

/** The runtime's default: UNCLASSIFIED < CUI < SECRET < TOP_SECRET. */
export const US_CLASSIFICATION = linearClassification(["UNCLASSIFIED", "CUI", "SECRET", "TOP_SECRET"]);

/** A Type's own marking — the classification of every object of it (`x-provenance.defaultClassification`). */
export function objectMarking(typeDef: TypeDefinition): string | undefined {
  return typeDef.schema["x-provenance"]?.defaultClassification;
}

/** A member's (property's or relationship's) own marking, `x-provenance.properties[member].classification`. */
export function memberMarking(typeDef: TypeDefinition, member: string): string | undefined {
  const properties = typeDef.schema["x-provenance"]?.properties;
  return properties && Object.hasOwn(properties, member) ? properties[member]?.classification : undefined;
}
