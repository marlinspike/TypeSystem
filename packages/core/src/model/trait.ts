import type { JsonSchema2020 } from "./json-schema.js";
import type { XRelationships, XActions, XComputed } from "./vocabulary.js";

/**
 * Reusable capability mixed into a Type via plain `allOf` (see ADR-0004).
 * A trait can contribute its own relationships/actions/computed properties,
 * which get merged into the composing Type at registration time.
 */
export interface TraitDefinition {
  name: string;
  description?: string;
  schema: JsonSchema2020;
  relationships?: XRelationships;
  actions?: XActions;
  computed?: XComputed;
}
