# @typesys/policy-cedar

A [Cedar](https://www.cedarpolicy.com/)-backed `PolicyEngine` for TypeS —
a drop-in replacement for `@typesys/core`'s embedded `AbacPolicyEngine`.
Cedar's authorizer runs in-process as WebAssembly
([`@cedar-policy/cedar-wasm`](https://www.npmjs.com/package/@cedar-policy/cedar-wasm)):
no sidecar, no network hop. See
[ADR-0031](../../docs/adr/0031-cedar-policy-engine.md).

## Use it

```ts
import { readFileSync } from "node:fs";
import { buildRuntime } from "@typesys/core";
import { CedarPolicyEngine } from "@typesys/policy-cedar";

const policyEngine = new CedarPolicyEngine({
  schema: readFileSync("policies/app.cedarschema", "utf8"),
  policies: readFileSync("policies/app.cedar", "utf8"),
  onError: (detail) => log.warn("cedar decision failed closed", detail)
});

const { runtime } = await buildRuntime({ manifests, adapters, policyEngine });
```

Nothing else changes: Types keep naming their policies in `x-policy` and
`authorizationPolicy`, and `SemanticRuntime` never knows which engine it has.
[`examples/`](examples/) holds a schema and policy set reproducing both demo
domains' rules, including the row-level own-patient rule
([ADR-0030](../../docs/adr/0030-row-level-authorization.md)).

## How a decision maps to Cedar

| TypeS `PolicyRequest` | Cedar |
|---|---|
| `subject.subjectId` | principal `TypeS::User::"<subjectId>"` |
| `subject.roles` | the principal's parents, `TypeS::Role::"<role>"` |
| `subject.attributes` | the principal's attributes |
| `policyName` | action `TypeS::Action::"<policyName>"` |
| `resource.typeName` (`hospital.Patient`) | entity type `hospital::Patient` |
| `resource.objectId` | the resource id — `"*"` on a type-level request |
| `resource.attributes` | the resource's attributes — none on a type-level request |

So the policy `hospital.read-patient` is written against
`action == TypeS::Action::"hospital.read-patient"`:

```cedar
@id("hospital.read-patient.assigned-clinician")
permit (principal in TypeS::Role::"clinician", action == TypeS::Action::"hospital.read-patient", resource)
when {
  resource has assignedClinicianId && principal has providerId &&
  resource.assignedClinicianId != "" && resource.assignedClinicianId == principal.providerId
};
```

## Writing the schema

- Declare `TypeS::Role`, `TypeS::User in [Role]`, and every policy name as a
  `TypeS::Action` whose `appliesTo` lists the resource types it guards.
- **Declare only the attributes a policy decides on.** They are the
  allow-list: nothing undeclared (a patient's name, a token's other claims)
  is ever given to Cedar.
- **Make every resource attribute optional (`attr?: String`).** A type-level
  request — an aggregate, a filter-property check — carries no attributes, so
  the engine refuses a required one, and Cedar's validator then makes every
  policy guard its reads with `has`.

## It fails closed

- **At load:** the schema and policies must parse, and the policies must
  validate against the schema in strict mode with **no errors or warnings**
  (an "impossible policy" warning is how a typo'd attribute behind `has`
  shows up — in a `forbid`, a silently open door). Otherwise the constructor
  throws `CedarPolicyError`.
- **Per decision:** only a Cedar `allow` with no evaluation errors allows —
  an erroring `forbid` that Cedar would skip is a deny. A declared attribute
  that isn't the schema's type fails the whole request closed rather than
  being dropped (a dropped attribute would disable every `forbid` reading
  it); `null` reads as absent. Deny reasons name policies by `@id` and never
  quote Cedar's messages, which can contain attribute values — those go to
  `onError`.

## Tests

`test/cedar-policy-engine.test.ts` covers the engine itself: the mapping,
the attribute allow-list, and every load-time and per-decision fail-closed
path. `test/parity.test.ts` runs both demo domains on `AbacPolicyEngine`
and on this engine over identical data and requires the same result and the
same audited decision at every policy checkpoint — every read path, object,
property, relationship, and the Action, for fifteen identities.
