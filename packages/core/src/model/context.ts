import type { Identity } from "./policy.js";
import type { Adapter } from "../runtime/adapter.js";

/** Shared execution context passed into computed-property and action-precondition callbacks. */
export interface RuntimeCallContext {
  identity: Identity;
  getAdapter(dataSourceId: string): Adapter;
  getProperty(propertyName: string): Promise<unknown>;
}

export type ComputeContext = RuntimeCallContext & { objectId: string; typeName: string };
export type ActionContext = RuntimeCallContext & { input: unknown };
