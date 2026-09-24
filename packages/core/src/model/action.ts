import type { JsonSchema2020 } from "./json-schema.js";
import type { ActionContext } from "./context.js";

/**
 * Actions are first-class governed capabilities, separate from the semantic
 * objects they operate on (see ADR-0005). The runtime enforces policy,
 * preconditions, and audit before dispatching to the adapter-implemented
 * side effect. Actions map 1:1 onto MCP tools.
 */
export type SideEffect = "none" | "creates" | "mutates" | "external";
export type Idempotency = "none" | "key" | "natural";

export interface PreconditionSpec {
  description: string;
  check: (ctx: ActionContext) => Promise<boolean>;
}

export interface ActionDefinition {
  id: string;
  name: string;
  description: string;
  applicableTypes: string[];
  inputSchema: JsonSchema2020;
  outputSchema: JsonSchema2020;
  authorizationPolicy: string;
  preconditions?: PreconditionSpec[];
  implementation: { dataSourceId: string; operation: string };
  sideEffects: SideEffect;
  idempotency: Idempotency;
  auditRequired: boolean;
  version: string;
  deprecated?: { since: string; supersededBy?: string };
}
