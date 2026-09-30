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
`{typeName, objectId?, propertyPath?, actionName?, attributes?}` — so one
rule can branch on whether it's guarding a whole object, one property, or
an Action.

## Decide on the object itself (row-level)

`req.resource.attributes` carries the object's stored values whenever the
runtime is deciding about one object, so a rule can scope access per
record ([ADR-0030](../adr/0030-row-level-authorization.md)). The hospital
domain's own-patient rule is built from the shipped helpers:

```ts
import { allOf, anyOf, requireAttributeMatch, requireRole } from "@typesys/core";

policyEngine.registerRule("hospital.read-patient", anyOf(
  requireRole("admin"),
  allOf(requireRole("clinician"), requireAttributeMatch("assignedClinicianId", "providerId")),
  allOf(requireRole("patient"), requireAttributeMatch("id", "patientId"))
));
```

`requireAttributeMatch(resourceAttribute, subjectAttribute)` allows only
when `resource.attributes[resourceAttribute]` and
`subject.attributes[subjectAttribute]` are the same non-empty string or
finite number, so a value missing on both sides never matches. The runtime
decides the object policy on every path that touches the object:
`getObject`, **each item of a `query`** (denied items are dropped, not
refused), the source and every target of a relationship, and the object
behind a property's provenance.

Two rules to write row-level rules by:

- **No attributes means "every instance".** `aggregate` and the
  filter/sort/search property checks ask about every row at once, without
  attributes. A rule that depends on attributes must deny there (the
  helpers do), which is what keeps a count from revealing rows the caller
  can't read. Never allow *because* attributes are missing.
- **Build rules from the helpers, and they plan themselves.**
  `requireRole`, `requireAttributeMatch`, `anyOf`, `allOf`, and
  `allowAllRule` also say what they admit, so `query` pushes the rule into
  the adapter's filter — full pages, and nothing read that the caller can't
  see — and `aggregate` counts exactly the rows the caller may read
  ([ADR-0038](../adr/0038-authorization-planning.md)). A plain function rule
  still works, decided after the read, but plans `unknown`.

## See what a rule plans

```ts
const report = await runtime.explainQuery({ type: "hospital.Patient" }, clinician);
report.plan;        // { kind: "predicate", predicate: { attribute: "assignedClinicianId", eq: "PR-2001" }, exact: true, … }
report.guarantees;  // { exact, paginationPrivate, aggregationSafe, postFilterRequired }
```

`explainQuery` is for operators: it reads no data, is audited, and is not
exposed over MCP, since a plan shows what the policy tests and the caller's
own values. To refuse any query whose plan isn't exact rather than
post-filtering it, construct the runtime with `rowSecurity: "require-exact"`.
Check a custom planner with `checkPlanConformance(engine, cases)`, which
reports every object the plan would hide.
- **Never echo a value into `reason`.** The reason is returned to the
  caller and audited. Name the attribute, not its value.

A rule that throws is a deny, audited like any other, so a rule reading an
attribute of an unexpected shape fails closed rather than crashing the read.
Inside `anyOf`, a throwing alternative is one that doesn't allow: the next
one is still tried. Inside `allOf`, a throw denies the whole conjunction.

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
see every property of it" are different questions, always. A property
policy only ever *narrows* the object policy: a property, relationship, or
provenance read needs both to allow.

Filtering is the one place a property policy *does* fail the call. A
`query` whose top-level `filter` references a property the caller can't
read is rejected with `AuthorizationError` (and audited as a deny),
because the filter runs in the adapter against unredacted values, and
the set of matching objects would reveal the hidden value. The check runs
once per Type with no `objectId`, so a rule that allows only some
objects' values denies the filter. Include-level filters don't need
this: they run after redaction.

## Every decision is audited, and (if you have an OTel SDK registered)
traced

You never have to log a decision yourself — `SemanticRuntime` calls
`registry.appendAuditEvent` on every single policy evaluation, including
the authorization preview `listActions` reports (it runs the same audited
gate as `invokeAction`), and (see
[`enable-observability.md`](enable-observability.md)) increments a
`typesys.policy.decisions` counter too. Check
`registry.listAuditEvents({limit, before})` to see what actually happened.

## Using a real policy engine instead (Cedar)

`AbacPolicyEngine` is a small, intentionally minimal implementation of the
`PolicyEngine` interface. `@typesys/policy-cedar` ships a real one —
Cedar, in-process — and nothing else in the runtime changes
([ADR-0031](../adr/0031-cedar-policy-engine.md)):

```ts
import { CedarPolicyEngine } from "@typesys/policy-cedar";

const policyEngine = new CedarPolicyEngine({ schema: cedarSchemaText, policies: cedarPolicyText });
const runtime = new SemanticRuntime(registry, adapters, policyEngine);
```

Each policy name becomes a Cedar action (`TypeS::Action::"fleet.read-widget"`),
so Types keep naming their policies exactly as above. The Cedar schema
declares which attributes policies may see, and the engine refuses to
build if a policy doesn't validate against it. See
[`packages/policy-cedar/README.md`](../../packages/policy-cedar/README.md)
for the mapping and
[`packages/policy-cedar/examples/`](../../packages/policy-cedar/examples/)
for both demo domains' rules written in Cedar. Anything else that implements
`evaluate(request): Promise<PolicyDecision>` (an OPA client, say) slots in
the same way.

## Verify it

Follow [`packages/core/test/policy-engine.test.ts`](../../packages/core/test/policy-engine.test.ts)
for unit-testing a rule in isolation, and
[`packages/domain-airforce/test/authorization-boundaries.test.ts`](../../packages/domain-airforce/test/authorization-boundaries.test.ts)
for testing it through the full runtime (object-level denial, property
redaction, and `listActions` reporting `authorized: false` without
throwing).
