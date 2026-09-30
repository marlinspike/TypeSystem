# 0030. Row-Level (Instance) Authorization

## Status

Accepted — implemented in `@typesys/core` (`PolicyResource.attributes` in
`model/policy.ts`; per-instance decisions, member narrowing, and the
deny-biased `decide` in `runtime/runtime.ts`; `requireAttributeMatch` /
`anyOf` / `allOf` in `policy/abac-policy-engine.ts`) and demonstrated by
`@typesys/domain-hospital`'s own-patient rule and the web demo's four new
row-level guardrails. Proven by:

- `packages/core/test/row-level-authorization.test.ts` — what a rule is
  given (frozen stored attributes, never computed ones; none on type-level
  requests); per-instance decisions on `getObject`, per-item `query`
  (dropped silently, audited per item, denied items never finalized or
  navigated), `getRelationship` source and targets, includes that reuse the
  source's attributes, `getProvenance`, instance-scoped property policies,
  and fail-closed aggregation; role-only rules unchanged; an **attack** block
  (getObject, filter/search probes, includes at any depth, allow-all member
  policies, include-filter probes, aggregation, `undefined === undefined`,
  wrong-shaped identity attributes, and no stored value in any error,
  reason, or audit row); and the deny-biased enforcement point (a throwing
  rule, a tampering rule, malformed decisions, a rejecting engine).
- `packages/core/test/policy-engine.test.ts` — the helpers in isolation.
- `packages/domain-hospital/test/row-level-authorization.test.ts` — the demo:
  each clinician reaches only their own patients through every read and
  include path, over the runtime *and* over MCP; an **attack** block where
  clinician B tries to read clinician A's patient by getObject, seven query
  shapes plus paging, `Appointment.patient`, the many-to-many
  `Provider.patients`, navigation from the patient, all four properties'
  provenance, and aggregation — every attempt denied, audited (five deny
  rows for five attempts), and free of PHI in errors, reasons, and audit.

Mutation-checked: removing the per-item drop, the relationship source
check, the provenance object check, the strict `allow === true`, the
engine-error catch, or the attributes freeze each fails at least one of
these tests.

## Context

Every policy decision today is made on *who* is asking and *what kind of
thing* they are asking about, never on the thing itself.
`PolicyRequest.resource` carries `{typeName, objectId?, propertyPath?,
actionName?}` (`packages/core/src/model/policy.ts`), and no rule can see a
single stored value of the object it is guarding. So the only rules anyone
can write are role- or subject-level: "any `clinician` can read any
`Patient`" (`packages/domain-hospital/src/setup.ts` says so in a comment,
calling per-instance scoping "a documented, not-built extension point").
`PRODUCTION-READINESS.md` item 8 lists this as blocking: most real
deployments need "this clinician can read *this* patient."

Three properties of the current read paths matter for closing it:

- **`query` decides once per Type.** It evaluates the object policy with
  `{typeName}` before the adapter runs, then returns every item the
  adapter produced. There is no per-item decision to hang an instance rule
  on.
- **Members *replace* the object policy rather than narrowing it.**
  `getRelationship` and `getProvenance` evaluate
  `propertyPolicies[name] ?? objectPolicy`. When a member declares its own
  policy, the object's policy is never consulted, so a caller who cannot
  read the object can still read its relationship or a property's
  provenance if the member policy allows. Harmless while every object
  policy is role-level (the member policies in this repo are narrower
  roles); a hole the moment the object policy is per-instance.
- **`getRelationship` already filters per item.** It resolves each related
  object through `getObject` and silently omits the ones the caller may not
  read, without failing the batch. That is the behavior a per-item `query`
  should have.

Row-level rules also make policy code likelier to throw (a rule reading an
attribute of an unexpected shape), and the runtime currently lets a
throwing rule escape as an exception, with no audit row.

## Decision

**1. `PolicyRequest.resource.attributes`: the object's stored values, on
instance-level requests only.** The runtime resolves an object's stored
values first (its base mapping merged with per-property overrides,
ADR-0023; pre-redaction; never computed properties, which may call other
adapters and don't exist until after authorization), then asks the policy
engine with those values as `resource.attributes`. The snapshot is frozen
and is the same one every decision about that object sees, so no rule can
change what the caller is later returned. Attributes are decision input
only: they are never written to the audit log and never returned.

A request **without** `attributes` is a *type-level* request, and it asks a
universal question: "may this subject do this for *every* instance, without
the runtime looking at any of them?" That is exactly what the runtime needs
where it cannot look — `aggregate` (the adapter computes over every row) and
the filter/sort/search property checks (the adapter filters every row before
redaction). A rule that depends on attributes cannot answer yes to a
universal question, so it denies; aggregation over an instance-guarded Type
therefore fails closed for everyone the rule doesn't allow unconditionally,
without the runtime needing to know which rules are instance-dependent.

**2. The object policy is decided per instance on every read path.**

- `getObject`: resolve stored values → object policy with attributes → only
  then computed properties and property-level redaction.
- `query`: no type-level gate. The object policy is evaluated **per returned
  item**, on that item's attributes; a denied item is dropped silently — the
  same treatment `getRelationship` already gives an unauthorized related
  object. Includes are resolved only for items that survived.
- `getRelationship`: the source object must be readable (decided on its
  attributes), and the related objects are each decided on their own, as
  today. An include's source was already authorized earlier in the same
  request, so an include passes its attributes along instead of
  re-resolving and re-deciding it.
- `getProvenance`: the object must be readable before any property's
  provenance is.
- Property policies receive the same attributes, so a field can be
  instance-scoped too ("the MRN is visible only to the assigned clinician").

**3. A member policy narrows the object policy; it never replaces it.** A
property, relationship, or provenance read is allowed only if the object is
readable *and* the member's own `propertyPolicies` entry, if any, allows.
This is how `getObject` has always treated property values; `getRelationship`
and `getProvenance` now agree with it.

**4. The enforcement point is deny-biased.** Only an explicit
`allow === true` allows. A policy engine that throws, rejects, or returns a
malformed decision is a deny, audited like any other, with a reason that
names the policy but not the error (whose message could quote an attribute).
This lives in `SemanticRuntime`, so it holds for every `PolicyEngine`, not
just `AbacPolicyEngine`.

**5. Composable rule helpers for instance rules.** `AbacPolicyEngine` gains
three small helpers next to `requireRole`: `requireAttributeMatch(resourceAttribute,
subjectAttribute)` (allows only when both are the same non-empty string or
finite number, read as own properties — so a missing value on both sides,
`undefined === undefined`, is never a match, and a type-level request with
no attributes is denied), plus `anyOf(...rules)` and `allOf(...rules)` (each
requires at least one rule, so an empty composition is a construction error,
not an open door). Deny reasons name attributes, never their values.

**6. The demo.** `hospital.Patient` gains `assignedClinicianId` (a Provider
id). Clinician identities carry `attributes.providerId`, and the patient
identity `attributes.patientId`. `hospital.read-patient` becomes:

```ts
anyOf(
  requireRole("admin"),
  allOf(requireRole("clinician"), requireAttributeMatch("assignedClinicianId", "providerId")),
  allOf(requireRole("patient"), requireAttributeMatch("id", "patientId"))
)
```

A clinician reads only the patients assigned to them, a patient only their
own record. Appointments stay role-level on purpose: which clinicians may
see an appointment (its provider? the patient's assigned clinician?) is a
domain-policy choice, not a mechanism gap, and this ADR does not make it.

Actions are out of scope. An `ActionDefinition` is not bound to a target
object (ADR-0005: it takes `input`, not an instance), so there is no stored
object for the runtime to resolve; action policies stay type-level.
Instance-scoped Action authorization needs an Action→target binding first.

## Consequences

- Rules can decide on the resource's own attributes and the subject's
  attributes together, on every read path. Role-only rules, which ignore
  attributes, decide exactly as before.
- **`query` no longer throws `AuthorizationError` for a caller the object
  policy denies; it returns only what they may read, possibly nothing.** An
  anonymous query of a guarded Type is an empty page, not a 403. Filter,
  sort, and search checks on a hidden property still reject the query.
- An unauthorized read now costs work before it is refused: `getObject`
  resolves the object's properties first, and `query` runs the adapter and
  decides per item. The page limits (ADR-0019) and the rate limiter bound
  it; both matter more now for unauthenticated traffic.
- Audit volume changes shape: `query` writes one object-policy row per
  returned item instead of one per call (it already wrote one row per
  item per property policy). An include with no relationship-level policy
  no longer writes a redundant row for its already-authorized source.
- Member policies are strictly tighter: a relationship or provenance read
  that was allowed only because the member policy replaced a denying object
  policy is now denied. No shipped domain relied on that.
- Aggregation over a Type whose read rule depends on attributes is denied
  unless the rule allows at the type level (e.g. `admin`), rather than
  counting rows the caller cannot see.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **Pagination is an inference channel.** Post-filtering is done after the
  adapter pages, so a page can come back short, or empty with a
  `nextCursor`. With `limit: 1` and a filter on a readable property, a caller
  learns whether rows they cannot read match that filter — a
  membership/count oracle (e.g. "is someone named X a patient here?"). The
  offset cursors all three adapters emit also reveal how many rows were
  scanned. Closing it needs the row rule pushed down into the adapter's
  query (RLS-style), which the engine-neutral `PolicyEngine` interface
  cannot express today. Decide whether the domain can accept it.
- **Timing.** A denied item and an allowed one take measurably different
  time (no finalization, no includes). Not addressed.
- **Rule authors own their deny reasons.** `reason` is returned to the
  caller. The shipped helpers never echo values; a hand-written rule that
  does will leak them. Review every custom rule's `reason`.
- **Attributes are the stored values the adapter returned.** Their
  integrity is the adapter's and the backend's: a writable
  `assignedClinicianId` is a writable authorization decision. Review who can
  write the fields your rules read.
- **The type-level contract is a convention for `AbacPolicyEngine` rules.**
  A hand-written rule that *allows* a request without attributes asserts
  that every instance is readable; one that allows "because attributes are
  missing" opens aggregation and hidden-field filters. The shipped helpers
  honor the contract; custom rules must too.
- **Appointments remain role-level** in the demo, so a clinician can see
  that another clinician's patient has an appointment (its `patientId`).
  Decide the domain's appointment rule before treating the hospital demo as
  a PHI pattern.

## Alternatives Considered

- **A separate `x-policy.instancePolicy` beside a type-level `objectPolicy`
  gate** (DRF's `has_permission` / `has_object_permission` split). Keeps
  `query`'s 403 for role-level denials and lets an unauthorized query be
  refused before any adapter work. Rejected: it gives every Type two
  read policies that must agree, and a type-level *gate* is unsound for any
  rule with an attribute-dependent `forbid` (the gate allows, an instance
  would have been denied) — so the gate can only ever reject, never
  replace, the per-item decision. One policy decided on the instance is
  simpler and cannot disagree with itself.
- **Keep the type-level gate on `query` as a pre-check.** A type-level
  *deny* only proves "not every instance", never "no instance", so it
  cannot short-circuit a row-level rule, and a type-level *allow* doesn't
  prove every instance readable either (see above). It would add a
  decision, an audit row, and no safety.
- **Push the row rule down into the adapter as a filter** (Postgres RLS,
  Oso data filtering, Cedar partial evaluation). The only design that also
  closes the pagination inference channel and makes aggregation correct
  rather than denied. Deferred: it needs the policy engine to emit a
  residual predicate in the query DSL, which neither `AbacPolicyEngine`
  rules (opaque functions) nor the `PolicyEngine` interface can do today,
  and a hand-maintained twin filter would drift from the rule it mirrors.
  The natural follow-up once a real engine can produce residuals.
- **Fill short pages by scanning ahead.** Hides a short page but not the
  cursor offset, and lets a caller who can see little make the runtime
  scan everything — a resource-exhaustion trade for a partial fix.
- **Let rules see computed properties too.** Rejected: computed properties
  can call other adapters (ADR-0022) and run with the caller's identity, so
  computing them for a caller before deciding whether that caller may read
  the object inverts the order of authorization and work.
- **Pass attributes as `PolicyRequest.context`.** `context` is the
  request's environment (time, IP, step-up state); attributes belong to the
  resource. Putting them on `resource` is also where Cedar and OPA inputs
  put them, which keeps the mapping to a real engine direct (ADR-0031).
