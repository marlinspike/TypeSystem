# 0009. Embedded ABAC Policy Engine

## Status

Accepted

## Context

Security must be foundational: object-level and property-level
authorization, action authorization, fail-closed behavior, and an audit
trail, all enforced independent of any particular UI or transport. The
mission brief simultaneously lists "a full policy engine" as an explicit
non-goal for the first implementation — meaning adopting a mature
policy-as-code system such as OPA (Rego) or Cedar wholesale was
off the table for v1, while the *interface boundary* for one still needed
to exist and be real.

## Decision

Define a minimal `PolicyEngine` interface
(`packages/core/src/model/policy.ts`): a single method,
`evaluate(request: PolicyRequest): Promise<PolicyDecision>`, where
`PolicyRequest` carries `{subject: Identity, action: "read" | "invoke",
policyName, resource: {typeName, objectId?, propertyPath?, actionName?},
context?}` and `PolicyDecision` is `{allow, reason?, obligations?}`.
`SemanticRuntime` is the only caller of this interface, at exactly the
points the mission brief specifies: object-level read (`x-policy.objectPolicy`),
property-level read (`x-policy.propertyPolicies[name]`, falling back to the
object policy), and action invocation (`ActionDefinition.authorizationPolicy`).

The implementation actually built is `AbacPolicyEngine`
(`packages/core/src/policy/abac-policy-engine.ts`): a `Map<policyName,
PolicyRule>` where each rule is a plain function,
`(request) => PolicyDecision | Promise<PolicyDecision>`, registered by name
via `registerRule()`. Two rule helpers ship: `allowAllRule` and
`requireRole(...roles)`. Critically, **an unregistered policy name denies by
default** — `evaluate()` returns `{allow: false, reason: 'No policy rule
registered for "..." (fail closed)'}` rather than throwing or silently
allowing, so a Type or Action authored with a typo'd or forgotten policy
name is safe by construction rather than accidentally open.

Because `SemanticRuntime` only ever depends on the `PolicyEngine` interface
— never on `AbacPolicyEngine` concretely — a real policy-as-code engine
(OPA, Cedar) could replace it later without touching any Runtime call site.

Identity and authentication follow the same "interface real, implementation
minimal" pattern. `Identity` (`{subjectId, roles, attributes,
tokenScopes?}`) already carries a seam for RFC 9396 rich authorization
requests (`tokenScopes`), not enforced in v1. The demo auth used by the MCP
server (`packages/mcp-server/src/auth.ts`) is a static map of a handful of
bearer tokens to canned `Identity` values
(`demo-maintainer-token`/`demo-viewer-token`). The real production path —
an OIDC-issued JWT verified against the issuer's JWKS, RFC 9207 issuer
validation, RFC 9396 rich authorization for fine-grained agent scoping — is
documented as the intended replacement, using the same `Identity`/
`PolicyEngine` interfaces, with only the token-verification implementation
differing. It is not built here because doing so would require a real
identity provider to verify against, which does not exist in this
codebase — building a fake OIDC flow just to exercise the code path would
be exactly the over-engineering the mission brief's non-goals warn against.

## Consequences

- Every authorization decision in this codebase, whichever transport it
  arrived through (direct Runtime call or MCP), goes through the same
  `PolicyEngine.evaluate()` call, so there is no separate MCP-specific
  authorization logic to keep in sync.
- Fail-closed is structural, not a convention someone has to remember —
  forgetting to register a policy rule denies rather than allows.
- The demo bearer-token map is explicitly not production authentication;
  anyone deploying this beyond the vertical slice must replace
  `resolveIdentity()`'s implementation, not its call sites.
- `PolicyDecision.obligations` and `PolicyRequest.context` exist as seams
  (e.g. for step-up authentication or attribute-based conditions beyond
  role membership) but are not populated or consumed by
  `AbacPolicyEngine`/`requireRole` today.

## Alternatives Considered

- **Adopting OPA or Cedar for v1**: rejected as the mission brief's
  explicit non-goal. Both are mature, capable systems, but integrating
  either (a sidecar process for OPA, or the Cedar authorization engine and
  its own policy language) is a real infrastructure and operational
  commitment that this pass's vertical slice does not need to prove the
  architecture — the `PolicyEngine` interface is the thing that needs to be
  right, and it is designed so either could be adopted later purely as an
  implementation swap.
- **Building a real OIDC/JWKS verification path now**: rejected — there is
  no identity provider in this environment to verify against, so any
  implementation would be unverifiable against a real IdP and would
  therefore be theater, not a tested capability.
