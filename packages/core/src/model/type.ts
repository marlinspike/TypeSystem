import type { SemanticTypeSchema } from "./vocabulary.js";
import type { RelationshipDefinition } from "./relationship.js";
import type { ComputeContext } from "./context.js";
import type { ResolutionMode } from "./data-source.js";

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
  resolutionMode: ResolutionMode;
  /** Only meaningful when `resolutionMode === "cached"`; falls back to the runtime's `defaultCacheTtlMs` (see ADR-0016). */
  cacheTtlMs?: number;
  /**
   * The stable key this compute implementation is registered under (see
   * `XComputedSpec.binding`). A durable `RegistryStore` (e.g. Postgres,
   * ADR-0015) can never persist `compute` itself — only this identifier —
   * and re-attaches the live function from a `BindingRegistry` supplied by
   * whichever process reads the Type back.
   */
  binding: string;
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
