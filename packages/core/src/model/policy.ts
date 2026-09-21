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
}

export interface PolicyRequest {
  subject: Identity;
  action: "read" | "invoke";
  resource: {
    typeName: string;
    objectId?: string;
    propertyPath?: string;
    actionName?: string;
  };
  context?: Record<string, unknown>;
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
  obligations?: string[];
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
}
