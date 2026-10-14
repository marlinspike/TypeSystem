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

/**
 * The one object an instance-scoped Action acts on (ADR-0053). Its id travels
 * in the Action's input, so every transport that can invoke the Action can
 * name the target the same way.
 */
export interface ActionTargetSpec {
  /** The top-level input property carrying the target's id: a required string in `inputSchema`. */
  idFrom: string;
  /** The target's Type. Defaults to `applicableTypes[0]`; must be one of `applicableTypes`. */
  type?: string;
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
  /**
   * Makes the Action instance-scoped (ADR-0053): the runtime reads the target
   * object first, under the caller's read authorization, and decides
   * `authorizationPolicy` on that object's attributes. Omitted, the Action is
   * decided per Type, as before.
   */
  target?: ActionTargetSpec;
  version: string;
  deprecated?: { since: string; supersededBy?: string };
}
