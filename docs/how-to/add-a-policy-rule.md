# How to add a policy rule

Every read and every Action invocation names a *policy* by string — a
Type's `x-policy.objectPolicy`, an individual property's entry in
`x-policy.propertyPolicies`, or an Action's `authorizationPolicy`. None of
that is a rule by itself; it's a lookup key into whichever `PolicyEngine`
the runtime was built with ([ADR-0009](../adr/0009-embedded-abac-policy-engine.md)).

## Register a rule

```ts
import { AbacPolicyEngine, requireRole, allowAllRule } from "@typesys/core";

const policyEngine = new AbacPolicyEngine();
policyEngine.registerRule("fleet.read-widget", requireRole("maintainer", "viewer"));
policyEngine.registerRule("fleet.maintainer-only", requireRole("maintainer"));
policyEngine.registerRule("fleet.public", allowAllRule);
```

An unregistered policy name **fails closed** — denied, not an error —
so a typo in a Type's `objectPolicy` string shows up as "nobody can read
this," not a crash. Check for that specifically if a read you expected to
work is unexpectedly denied.

## Write your own rule

A rule is just a function —
`(request: PolicyRequest) => PolicyDecision | Promise<PolicyDecision>`
(see [`packages/core/src/model/policy.ts`](../../packages/core/src/model/policy.ts)):

```ts
policyEngine.registerRule("fleet.own-region-only", (req) => {
  const region = req.context?.region;
  const allow = region != null && req.subject.attributes.regions?.includes(region);
  return { allow, reason: allow ? undefined : `Subject is not assigned to region "${region}"` };
});
```

`req.resource` tells you what's being checked —
`{typeName, objectId?, propertyPath?, actionName?}` — so one rule can
branch on whether it's guarding a whole object, one property, or an
Action.

## Property-level redaction, not just allow/deny

A property-level denial doesn't fail the read — the property is silently
omitted from the response (see
[`packages/domain-airforce/test/authorization-boundaries.test.ts`](../../packages/domain-airforce/test/authorization-boundaries.test.ts)):

```ts
"x-policy": {
  objectPolicy: "fleet.read-widget",
  propertyPolicies: { internalNotes: "fleet.maintainer-only" }
}
```

A viewer can read the Widget; `internalNotes` just won't be in `values`
for them. This is deliberate — "you can retrieve an object" and "you can
see every property of it" are different questions, always.

## Every decision is audited, and (if you have an OTel SDK registered)
traced

You never have to log a decision yourself — `SemanticRuntime` calls
`registry.appendAuditEvent` on every single policy evaluation, and (see
[`enable-observability.md`](enable-observability.md)) increments a
`typesys.policy.decisions` counter too. Check
`registry.listAuditEvents({limit, before})` to see what actually happened.

## Using a real policy engine instead (OPA/Cedar)

`AbacPolicyEngine` is a small, intentionally minimal implementation of the
`PolicyEngine` interface — swap it for anything else that implements
`evaluate(request): Promise<PolicyDecision>` and nothing else in the
runtime changes:

```ts
const runtime = new SemanticRuntime(registry, adapters, myOpaBackedPolicyEngine);
```

## Verify it

Follow [`packages/core/test/policy-engine.test.ts`](../../packages/core/test/policy-engine.test.ts)
for unit-testing a rule in isolation, and
[`packages/domain-airforce/test/authorization-boundaries.test.ts`](../../packages/domain-airforce/test/authorization-boundaries.test.ts)
for testing it through the full runtime (object-level denial, property
redaction, and `listActions` reporting `authorized: false` without
throwing).
