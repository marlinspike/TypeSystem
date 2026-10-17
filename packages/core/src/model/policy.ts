import type { AuthorizationPlan } from "../policy/authorization-plan.js";
import type { PlanAssurance } from "../runtime/security-profile.js";

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
  /**
   * When the credentials this identity was resolved from stop being valid
   * (ISO 8601), as a verifying resolver reads it from the token (`exp`).
   * Requests are resolved fresh, so the runtime does not read it; anything
   * that holds an identity beyond one request (a workflow run, ADR-0065)
   * must not act on it after this instant.
   */
  expiresAt?: string;
  /**
   * Where what this caller reads goes next (ADR-0067): the model or
   * execution environment that receives it. Bound, the runtime allows a
   * decision only when the subject *and* the audience are allowed, so being
   * allowed to read data never by itself releases it to a model. Bound by
   * the host (the MCP or HTTP server the agent talks through, the workflow
   * engine for an AI step), never by the caller.
   */
  audience?: Audience;
}

/**
 * A recipient of data other than the person who asked for it (ADR-0067): a
 * hosted model, a model in an enclave, a sandbox that runs generated code.
 * Policies and classification schemes decide about it as a principal of its
 * own: it holds `roles` and `attributes` (provider, hosting, environment)
 * and a `clearance`, granted to it by policy like anyone else's. It is
 * granted nothing by default.
 */
export interface Audience {
  /** Stable and specific, e.g. `model:acme/large@us-gov-east`. Audited with every decision about it. */
  id: string;
  kind: "model" | "environment" | "service";
  roles: string[];
  attributes: Record<string, unknown>;
  clearance?: string;
}

/** The audience as the principal a policy engine or classification scheme decides about. `attributes.principalKind` names its kind. */
export function audienceIdentity(audience: Audience): Identity {
  return {
    subjectId: audience.id,
    roles: [...audience.roles],
    attributes: { ...audience.attributes, principalKind: audience.kind },
    ...(audience.clearance !== undefined ? { clearance: audience.clearance } : {})
  };
}

/** `identity` with what it reads bound for `audience` (ADR-0067). An audience already bound is kept only if it is the same one: an identity is never re-bound to a different recipient. */
export function withAudience(identity: Identity, audience: Audience): Identity {
  if (identity.audience && identity.audience.id !== audience.id) throw new TypeError(`Identity ${identity.subjectId} is already bound to audience ${identity.audience.id}`);
  return { ...identity, audience };
}

/**
 * Turns a bearer token (or none) into an `Identity`, fresh on every request,
 * for every transport (MCP over stdio and HTTP, the REST API). It is the whole
 * of a server's authentication and always supplied by its host: no server
 * assumes an identity of its own (ADR-0050). `@typesys/auth-oidc` provides a
 * verifying one.
 */
export type IdentityResolver = (token: string | undefined | null) => Promise<Identity>;

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
  /**
   * Parts of the rule that failed to evaluate (ADR-0043), in short fixed
   * text — never an error message, which could quote an attribute value.
   * Carried whatever the decision is: an allow reached around a broken
   * branch still reports the branch. Audited as `details.faults`.
   */
  faults?: string[];
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
  /**
   * Optional (ADR-0038): what `request`'s policy admits for its subject,
   * across every object of `request.resource.typeName` — a type-level
   * request. MUST be a sound over-approximation: every object `evaluate`
   * would allow, the plan admits. An engine without it plans `unknown`.
   */
  plan?(request: PolicyRequest): Promise<AuthorizationPlan>;
  /**
   * Optional (ADR-0046): `"structural"` only when this engine derived the
   * plan for `request` from the same rule structure it evaluates, by code it
   * ships. A security profile admits aggregation only through such a plan.
   */
  planAssurance?(request: PolicyRequest): PlanAssurance | Promise<PlanAssurance>;
  /**
   * Optional (ADR-0088): the structure of the rule registered under
   * `policyName`, as short text for a person or agent inspecting the model
   * (`role in [maintainer, lead]`). Never a decision, and never anything
   * about a subject or a resource. `undefined` when the engine cannot say.
   */
  describe?(policyName: string): string | undefined | Promise<string | undefined>;
}

/**
 * One policy decision for an identity that may carry an audience
 * (ADR-0067), for code that asks a `PolicyEngine` directly rather than
 * through the runtime (the workflow engine's start, approval and cancel
 * policies): the subject and the audience are each decided, and both must
 * allow. Deny-biased: an engine that throws denies.
 */
export async function decideForIdentity(engine: PolicyEngine, request: PolicyRequest): Promise<PolicyDecision> {
  const ask = (r: PolicyRequest): Promise<PolicyDecision> =>
    engine.evaluate(r).then(
      (d) => (d?.allow === true ? d : { allow: false, reason: typeof d?.reason === "string" ? d.reason : `Policy "${r.policyName}" did not allow` }),
      () => ({ allow: false, reason: `Policy "${r.policyName}" failed to evaluate (fail closed)` })
    );
  const { audience, ...person } = request.subject;
  const forPerson = await ask({ ...request, subject: person });
  if (!audience || !forPerson.allow) return forPerson;
  const forAudience = await ask({ ...request, subject: audienceIdentity(audience) });
  return forAudience.allow ? forPerson : { allow: false, reason: `Not releasable to ${audience.id}: ${forAudience.reason ?? "not allowed"}` };
}

/**
 * An `IdentityResolver` whose every identity reads for `audience`
 * (ADR-0067): give it to an MCP or HTTP server that an agent talks
 * through, naming the model behind the agent, and everything that agent
 * reads is decided for its user *and* its model.
 */
export function bindAudience(resolver: IdentityResolver, audience: Audience): IdentityResolver {
  return async (token) => withAudience(await resolver(token), audience);
}
