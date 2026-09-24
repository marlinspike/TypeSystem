import type { SemanticTypeSchema } from "./vocabulary.js";
import type { RelationshipDefinition } from "./relationship.js";
import type { ComputeContext } from "./context.js";

/**
 * A Type's stable, namespaced logical name (e.g. "airforce.Aircraft") is
 * what consumers reference. It is independent of the registry-assigned
 * immutable `id` and of the semver `version` (see ADR-0002) — display
 * names/descriptions can change freely without breaking references.
 */
export interface TypeIdentity {
  id: string;
  name: string;
  version: string;
  /** Single level only — no deep inheritance chains (see ADR-0004). */
  extends?: string;
  traits?: string[];
}

export interface ComputedPropertyDefinition {
  name: string;
  dependsOn: string[];
  resolutionMode: "live" | "materialized" | "cached";
  compute: (ctx: ComputeContext) => Promise<unknown>;
}

export interface TypeDefinition extends TypeIdentity {
  description?: string;
  schema: SemanticTypeSchema;
  /** Materialized from the schema's `x-relationships` at registration time — never re-parsed at query time. */
  relationships: RelationshipDefinition[];
  actionNames: string[];
  computedProperties: ComputedPropertyDefinition[];
  deprecated?: { since: string; supersededBy?: string; sunsetAt?: string };
  /** old property/relationship name -> new name, exercised during a transition window (see ADR-0010). */
  aliases?: Record<string, string>;
}
