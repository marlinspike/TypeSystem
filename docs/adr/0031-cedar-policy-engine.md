# 0031. A Cedar Policy Engine, In-Process

## Status

Accepted — implemented as `@typesys/policy-cedar` (`CedarPolicyEngine`,
`src/mapping.ts` for the request mapping, `src/schema.ts` for the schema
checks) with a reference schema and policy set for both demo domains in
`packages/policy-cedar/examples/`. Proven by:

- `packages/policy-cedar/test/parity.test.ts` — both demo domains run on
  `AbacPolicyEngine` and on `CedarPolicyEngine` over identical data; for
  fifteen identities (the demo ones plus edge cases: an admin, clinicians
  with no, empty, or token-shaped provider ids, a patient with an empty id,
  every role at once, spoofed role strings) and every read path over every
  object, property, and relationship plus the Action, results *and* every
  audited decision must match: 2,422 scenarios, 3,318 individual decisions
  (1,429 allows, 1,889 denies), identical. Then row-level attacks
  (clinician B vs. clinician A's patient) under Cedar, and the intended
  divergences pinned explicitly.
- `packages/policy-cedar/test/cedar-policy-engine.test.ts` — the engine on
  its own, through the real WebAssembly authorizer: decisions and reasons;
  the attribute allow-list; every load-time refusal (unparseable schema or
  policies, an undeclared attribute, an unguarded optional attribute, an
  impossible policy, a required resource attribute, a missing identity model,
  duplicate ids, templates); and every per-decision fail-closed path (an
  erroring `forbid` Cedar alone would allow, a wrong-typed attribute, an
  undeclared action or resource type, malformed request shapes), with no
  attribute value in any reason.

Mutation-checked: loosening a policy in the example set (dropping the
empty-string guard, widening `staff-only`), allowing despite evaluation
errors, dropping role membership, passing undeclared attributes, or
dropping wrong-typed values each fails the suites.

**Amended during implementation (points 3 and 4):** declared attributes
are no longer sanitized to "safe" shapes and dropped otherwise. That was the
first design, and it was wrong: a dropped attribute silently disables every
`forbid` that reads it. A declared value now goes to Cedar as-is and Cedar's
schema check refuses the whole request if it isn't the declared type; and
validator *warnings* are fatal at load, not just errors.

## Context

`PRODUCTION-READINESS.md` item 1 says the whole security boundary runs
through `AbacPolicyEngine`, a hand-rolled `Map<policyName, PolicyRule>`, and
asks for it to be replaced by OPA or Cedar "or proven enough." ADR-0009 left
the `PolicyEngine` interface as the seam for exactly that swap, but nothing
has ever gone through it: no second engine exists, so "swappable" is a claim,
not a demonstrated property. ADR-0030 then made the seam carry more (an
object's stored attributes, and the type-level/instance-level distinction),
which is exactly what a real engine needs to see and exactly what a naive
port could get wrong.

Hand-written rule functions have two weaknesses a real engine removes. They
are opaque: nothing can check, before a request arrives, that a rule reads
only attributes that exist, of the types it expects, or that a rule reading
an optional attribute handles its absence. And they are unaudited as rules:
a policy set in a policy language can be reviewed, diffed, and analyzed as
data. The question this ADR answers is whether a real engine drops in
behind `PolicyEngine` with no runtime change, and decides identically.

## Decision

**1. A new optional package, `@typesys/policy-cedar`, never a core
dependency** (the `auth-oidc` / `redis` / `adapter-postgres` pattern).
`CedarPolicyEngine implements PolicyEngine`, built on
`@cedar-policy/cedar-wasm` — the Cedar authorizer compiled to WebAssembly and
run in-process. There is no sidecar, no network hop, and no second process
to deploy or fail.

**2. A fixed, documented mapping from `PolicyRequest` to a Cedar request.**

| TypeS | Cedar |
|---|---|
| `subject.subjectId` | principal `TypeS::User::"<subjectId>"` |
| `subject.roles` | the principal's parents, `TypeS::Role::"<role>"` |
| `subject.attributes` | the principal's attributes |
| `policyName` | action `TypeS::Action::"<policyName>"` |
| `resource.typeName` `"hospital.Patient"` | entity type `hospital::Patient` |
| `resource.objectId` | the resource's id; `"*"` on a type-level request |
| `resource.attributes` | the resource's attributes; none on a type-level request |

The policy name *is* the Cedar action. TypeS already binds named policies to
Types, properties, and Actions (`x-policy`, `authorizationPolicy`), so mapping
each name to one Cedar action keeps every Type definition unchanged and keeps
the fail-closed rule for an unknown name: an action the schema doesn't
declare fails request validation, and a declared one with no matching
`permit` is Cedar's default deny. `context` is empty.

**3. The schema is the allow-list of what a policy can see.** Only attributes
the Cedar schema declares for the principal or resource entity type are
passed; undeclared ones are dropped. This is least privilege for decision
input (a Patient's name and MRN never reach the engine if no policy needs
them), and it is also necessary: Cedar rejects an entity carrying an
undeclared attribute, and an OIDC identity's `attributes` are its whole
token payload (ADR-0018). A *declared* attribute that is `null` or missing
is absent. Any other declared value is passed as it is, and if it isn't the
declared type Cedar's schema check refuses the whole request — it is never
quietly dropped, because a dropped attribute would silently disable every
`forbid` that reads it. A value that isn't JSON data at all (a function, a
non-finite number) is refused the same way.

**4. Validated at load, fail closed at request time.**

- At construction the engine parses the schema and the policies, validates
  the policies against the schema in strict mode, and throws
  `CedarPolicyError` on any error **or warning** — an engine that cannot be
  trusted is never built. Warnings are fatal because Cedar types `resource
  has attr` on an undeclared attribute as statically false: a typo'd
  attribute behind a `has` guard validates, with only an "impossible policy"
  warning, and in a `forbid` that is a silently open door. Two structural checks sit beside Cedar's: the schema must declare
  `TypeS::User` and `TypeS::Role`, and **every attribute of every resource
  entity type must be optional**. A type-level request carries no attributes
  (ADR-0030), so a required attribute would make every type-level request
  fail; optional attributes make Cedar's validator reject any policy that
  reads one without a `has` guard — which turns ADR-0030's "a rule that
  needs attributes must deny a type-level request" from a convention into a
  statically checked property.
- At request time the engine allows only on a Cedar `allow` with **no
  evaluation errors**. Cedar skips a policy that errors, so an erroring
  `forbid` beside a matching `permit` yields `allow`; the engine denies
  instead. A failed request (a type-mismatched attribute, an undeclared
  action or resource type, a thrown WASM call) is a deny.
- Deny reasons name policies (`@id` annotations become policy ids) and never
  carry Cedar's own messages, which can quote attribute values. Those go to
  an optional `onError` hook for an operator's log.

**5. Policies are preparsed once.** The policy set and schema are parsed into
cedar-wasm's cache under a per-engine random id and evaluated with
`statefulIsAuthorized` — about 0.03 ms a decision against 0.4 ms re-parsing
per call, which matters because `query` now decides per returned item.

**6. A reference policy set for both demo domains, including ADR-0030's
own-patient rule** (`packages/policy-cedar/examples/`), proven equivalent to
the `AbacPolicyEngine` rules by a parity suite that runs every read path,
every object, every property, and the Action against both engines, for
every demo identity and a set of edge-case identities, and requires
identical results.

## Consequences

- The `PolicyEngine` seam is demonstrated, not claimed: the same registry,
  adapters, and runtime decide identically under a hand-written engine and a
  real one, and nothing in `@typesys/core` changed to allow it.
- A policy set can now be reviewed as data and is checked against a schema
  before the process serves a request: an attribute typo, a type error, or an
  unguarded optional attribute is a startup failure, not a silent deny.
- Cedar is stricter than the ABAC helpers in one direction, and the parity
  suite pins it: a declared attribute of the wrong type fails the whole
  request, where `requireAttributeMatch` merely fails to match it. So an
  identity whose `providerId` claim arrives as an array is refused
  *everything* under Cedar, even the public provider directory, and an object
  whose stored `assignedClinicianId` is a number is unreadable even to an
  admin. Both are fail-closed, and both surface through `onError`; they are
  configuration or data errors, which is why they are loud rather than
  tolerated.
- `null` reads as absent. A `forbid` meant to cover a *missing* value too
  needs its own `!(resource has attr)` clause; the engine can't tell a
  deliberately-null field from a missing one.
- The package pulls in a ~4 MB WebAssembly binary (per build target; the
  Node build is the one loaded), instantiated synchronously at import. `@typesys/core` stays dependency-light because the package is
  optional.
- cedar-wasm's preparsed cache is process-global and has no eviction; an
  engine is meant to be built once per process. Building many (as the tests
  do) only costs memory.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **The mapping (point 2) is the security-relevant surface.** Review it
  against how your identity provider fills `subjectId`, `roles`, and
  `attributes`: roles become Cedar group membership, so whoever can mint a
  role string can mint `principal in TypeS::Role::"admin"`.
- **Review the policy set as a policy set.** The shipped one reproduces the
  demo rules; it is not a policy design for a real domain. Cedar's
  SMT-based analysis tooling can prove properties such as "no clinician can
  read an unassigned patient" over *all* inputs — not run here.
- **Schema types must match what adapters actually return.** A mismatch is a
  deny for every request touching that object or identity (point 3), so an
  adapter or IdP change can lock users out. Watch `onError` in operation.
- **`null` as absent** (above) is a policy-authoring hazard for `forbid`
  rules; review every `forbid` for it.
- **Supply chain.** `@cedar-policy/cedar-wasm` is a binary artifact pinned
  to an exact version (4.13.0); it has not been through a dependency review
  here (`PRODUCTION-READINESS.md` item 16).
- **Parity is proven on the demo domains' data**, not on every conceivable
  input. The unit suite covers the edge cases (empty strings, missing and
  wrong-typed values), but a new domain's rules need their own parity or
  property tests.

## Alternatives Considered

- **OPA (Rego), as a sidecar or via its WASM compilation.** A sidecar is a
  second process, a network hop on every decision (now per returned item),
  and a new failure mode; OPA's WASM target requires a policy build step and
  loses built-ins. Cedar's validator also gives the static schema checks
  point 4 relies on, which Rego has no equivalent for.
- **Model Cedar actions as `read` / `invoke` on a resource type, ignoring
  policy names** (the "Cedar-native" shape). More idiomatic for a greenfield
  Cedar deployment, but it would make TypeS's named policies meaningless,
  force a property policy to be told apart from an object policy through
  `context`, and change every domain's Type definitions. Mapping the name to
  the action keeps both models intact.
- **Pass every attribute and skip schema validation at request time.**
  Simpler, and tolerant of unknown claims — but it gives up Cedar's type
  checking of the entities themselves, so a wrong-typed attribute is compared
  rather than refused, and it sends every PHI field into the engine whether a
  policy needs it or not.
- **Sanitize declared attributes and drop what doesn't fit** (this ADR's
  first design). It gives exact parity with `AbacPolicyEngine` on malformed
  data and keeps a user with one bad claim able to read public resources.
  Rejected during implementation: a dropped attribute reads as absent, which
  turns off every `forbid` guarded by `has` on it — a wrong-typed
  `classification` would un-forbid a secret record. Refusing the request is
  the only choice that is closed for `forbid` and `permit` alike.
- **Re-parse the policy set on every call (`isAuthorized`).** No global
  state, but ~12x slower per decision, which per-item `query` decisions
  multiply by the page size.
- **Use Cedar partial evaluation to push row rules into the adapter query.**
  The real fix for ADR-0030's pagination inference channel, and cedar-wasm
  exposes `isAuthorizedPartial`. Deferred: translating residuals into the
  query DSL is its own design, and still experimental in Cedar.
