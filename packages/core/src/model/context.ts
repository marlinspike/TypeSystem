import type { Identity } from "./policy.js";
import type { Adapter } from "../runtime/adapter.js";

/** Shared execution context passed into computed-property and action-precondition callbacks. */
export interface RuntimeCallContext {
  identity: Identity;
  getAdapter(dataSourceId: string): Adapter;
  getProperty(propertyName: string): Promise<unknown>;
}

/**
 * For a computed property, `getProperty` reads only the inputs that
 * property's own `dependsOn` names (ADR-0052); any other name reads as
 * `undefined`, since every read gate is decided over `dependsOn`.
 */
export type ComputeContext =RuntimeCallContext & { objectId: string; typeName: string };
/**
 * For an instance-scoped Action (ADR-0053), `target` names the object it acts
 * on and `getProperty` reads that object's stored values as the caller's own
 * read would show them: a value classified out or denied by its property
 * policy reads as `undefined`, and a precondition that reads one is not
 * decided for that caller (the invocation is refused, the preview reports
 * `satisfied: null`).
 */
export type ActionContext = RuntimeCallContext & { input: unknown; target?: { typeName: string; objectId: string } };
