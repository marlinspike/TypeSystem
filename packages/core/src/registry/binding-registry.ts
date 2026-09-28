import type { ComputeContext, ActionContext } from "../model/context.js";

/**
 * The rehydration seam a durable `RegistryStore` (ADR-0015) needs: a
 * `ComputedPropertyDefinition`/`PreconditionSpec` persisted to a database
 * carries only a stable string key (`binding`/`bindingId`), never the
 * function itself. Whichever process reads Types/Actions back from that
 * store supplies a `BindingRegistry` containing the real implementations —
 * exactly like `Adapter` instances are supplied to `SemanticRuntime` rather
 * than persisted (see ADR-0006).
 */
export type ComputeBinding = (ctx: ComputeContext) => Promise<unknown>;
export type PreconditionBinding = (ctx: ActionContext) => Promise<boolean>;

export interface BindingRegistry {
  computed: Record<string, ComputeBinding>;
  preconditions: Record<string, PreconditionBinding>;
}

export function emptyBindingRegistry(): BindingRegistry {
  return { computed: {}, preconditions: {} };
}

export function mergeBindingRegistries(...registries: BindingRegistry[]): BindingRegistry {
  const merged = emptyBindingRegistry();
  for (const r of registries) {
    Object.assign(merged.computed, r.computed);
    Object.assign(merged.preconditions, r.preconditions);
  }
  return merged;
}

export class MissingBindingError extends Error {
  constructor(kind: "computed" | "precondition", bindingKey: string, context: string) {
    super(
      `No ${kind} binding registered for "${bindingKey}" (${context}). Every process reading this Type/Action ` +
        `from a durable RegistryStore must supply a BindingRegistry containing this key (see ADR-0015) — ` +
        `the database never stores or executes code.`
    );
    this.name = "MissingBindingError";
  }
}
