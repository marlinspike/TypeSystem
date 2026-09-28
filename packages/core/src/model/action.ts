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
  /**
   * Stable key this precondition's `check` is registered under. Optional
   * because in-process authoring (a literal inline closure) never needs
   * one — required only if this ActionDefinition will be persisted to a
   * durable `RegistryStore` (ADR-0015), which strips `check` and re-attaches
   * it from a `BindingRegistry` by this key on read.
   */
  bindingId?: string;
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
