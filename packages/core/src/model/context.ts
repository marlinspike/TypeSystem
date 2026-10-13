import type { Identity } from "./policy.js";
import type { Adapter } from "../runtime/adapter.js";

/** Shared execution context passed into computed-property and action-precondition callbacks. */
export interface RuntimeCallContext {
  identity: Identity;
  getAdapter(dataSourceId: string): Adapter;
  getProperty(propertyName: string): Promise<unknown>;
}

export type ComputeContext = RuntimeCallContext & { objectId: string; typeName: string };
/**
 * For an instance-scoped Action (ADR-0053), `target` names the object it acts
 * on and `getProperty` reads that object's stored values, which the runtime
 * already authorized the caller to read.
 */
export type ActionContext = RuntimeCallContext & { input: unknown; target?: { typeName: string; objectId: string } };
