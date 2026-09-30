import type { TypeDefinition } from "../model/type.js";
import type { ProvenanceRef } from "../model/provenance.js";

/**
 * How clearances compare to classification markings (ADR-0032, ADR-0034).
 * The runtime asks only `dominates`, and only about real markings — unmarked
 * data never reaches a scheme — so an ordered list (`linearClassification`)
 * and a lattice with compartments or caveats plug in the same way.
 */
export interface ClassificationScheme {
  /** Identifies the scheme in audit rows (`details.scheme`), so an operator can tell which one decided. */
  readonly name: string;
  /**
   * Whether a subject holding `clearance` (none: `undefined`) may read data
   * marked `marking`. Must be `false` for a marking the scheme doesn't
   * recognize, so a typo or a foreign label is readable by no one.
   */
  dominates(clearance: string | undefined, marking: string): boolean;
}

/** A linear scheme, which also exposes its ordering — lowest first — for display. */
export interface LinearClassificationScheme extends ClassificationScheme {
  readonly levels: readonly string[];
}

/**
 * An ordered scheme, lowest level first. A missing or unrecognized
 * clearance holds only the lowest level; an unrecognized marking is
 * dominated by no clearance. Markings compare as exact strings.
 */
export function linearClassification(levels: readonly string[], name = "linear"): LinearClassificationScheme {
  if (levels.length === 0) throw new TypeError("linearClassification() needs at least one level");
  const rank = new Map(levels.map((level, i) => [level, i]));
  if (rank.size !== levels.length) throw new TypeError("linearClassification() levels must be distinct");
  return {
    name,
    levels: Object.freeze([...levels]),
    dominates(clearance, marking) {
      const required = rank.get(marking);
      if (required === undefined) return false;
      const held = (clearance === undefined ? undefined : rank.get(clearance)) ?? 0;
      return held >= required;
    }
  };
}

/**
 * A demonstration ordering, UNCLASSIFIED < CUI < SECRET < TOP_SECRET — not
 * the US classification model (ADR-0034). Real markings carry compartments
 * and dissemination controls a linear order can't express, and CUI is a
 * separate regime governed by category and lawful purpose, not a level
 * between UNCLASSIFIED and SECRET. Use it for demos and tests; a deployment
 * with real markings needs its own reviewed scheme.
 */
export const DEMO_LINEAR_CLASSIFICATION = linearClassification(["UNCLASSIFIED", "CUI", "SECRET", "TOP_SECRET"], "demo-linear");

/**
 * The runtime's default (ADR-0034): unmarked data is allowed — it never asks
 * a scheme — and marked data is denied, whatever the clearance. So
 * classification enforcement can't be switched off by forgetting to
 * configure it: marked data stays unreadable until a deployment chooses a
 * scheme that can dominate its markings.
 */
export const DENY_MARKED_DATA: ClassificationScheme = Object.freeze({
  name: "deny-marked-data",
  dominates: () => false
});

/** A Type's own markings — the classification of every object of it (`x-provenance.defaultClassification`). Empty when unmarked. */
export function objectMarkings(typeDef: TypeDefinition): string[] {
  const marking = typeDef.schema["x-provenance"]?.defaultClassification;
  return marking === undefined ? [] : [marking];
}

/** A member's (property's or relationship's) own markings, `x-provenance.properties[member].classification`. Empty when unmarked. */
export function memberMarkings(typeDef: TypeDefinition, member: string): string[] {
  const properties = typeDef.schema["x-provenance"]?.properties;
  const marking = properties && Object.hasOwn(properties, member) ? properties[member]?.classification : undefined;
  return marking === undefined ? [] : [marking];
}

/** Whether the Type or any of its members carries a marking. */
export function isMarked(typeDef: TypeDefinition): boolean {
  const properties = typeDef.schema["x-provenance"]?.properties ?? {};
  return objectMarkings(typeDef).length > 0 || Object.keys(properties).some((member) => memberMarkings(typeDef, member).length > 0);
}

/** The markings stored values carry in their provenance (`ProvenanceRef.classification`). Empty when none do. */
export function valueMarkings(provenance: readonly ProvenanceRef[]): string[] {
  return provenance.flatMap((p) => (p.classification === undefined ? [] : [p.classification]));
}
