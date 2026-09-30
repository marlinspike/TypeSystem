/**
 * Object- and property-level authorization boundary. Deliberately a small
 * embedded interface rather than adopting OPA/Cedar wholesale for v1 (see
 * ADR-0009) — the runtime is the only caller, at the Query/Action boundary,
 * so a real policy engine could be swapped in later without touching call
 * sites.
 */
export interface Identity {
  subjectId: string;
  roles: string[];
  attributes: Record<string, unknown>;
  /** Seam for RFC 9396 rich authorization requests; not enforced in v1. */
  tokenScopes?: string[];
  /**
   * The highest classification this subject may read (ADR-0032), as the
   * runtime's `ClassificationScheme` names it. Missing or unrecognized, the
   * subject holds only the scheme's lowest level.
   */
  clearance?: string;
}

/** What a policy decision is about: a Type, or one object of it, or one of that object's members or Actions. */
export interface PolicyResource {
  typeName: string;
  objectId?: string;
  propertyPath?: string;
  actionName?: string;
  /**
   * The object's stored values — adapter-resolved, pre-redaction, never
   * computed properties — present only on an *instance-level* request
   * (ADR-0030). A request without them is *type-level* and asks about every
   * instance at once (an aggregate, a filter/sort/search property check), so
   * a rule that depends on attributes must deny it. Frozen, for the decision
   * only: never returned to the caller or written to the audit log.
   */
  attributes?: Readonly<Record<string, unknown>>;
}

export interface PolicyRequest {
  subject: Identity;
  action: "read" | "invoke";
  /** The named rule to evaluate, e.g. a Type's objectPolicy, a propertyPolicy, or an Action's authorizationPolicy. */
  policyName: string;
  resource: PolicyResource;
  context?: Record<string, unknown>;
}

export interface PolicyDecision {
  allow: boolean;
  /** Returned to the caller on a deny, and audited — so it must never quote `resource.attributes` values. */
  reason?: string;
  obligations?: string[];
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
}
