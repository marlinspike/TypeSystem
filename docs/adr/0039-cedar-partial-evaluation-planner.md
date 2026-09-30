# 0039. Cedar Planning Through Partial Evaluation

## Status

Accepted — implemented as `CedarPolicyEngine.plan()` and the
`schemaConformantData` option in `@typesys/policy-cedar`
(`src/cedar-policy-engine.ts`, the residual translator in `src/planner.ts`),
with the three limitation codes in `@typesys/core`. Proven by
`packages/policy-cedar/test/planning.test.ts`:

- the demo rule's real residual simplifying to one exact atom;
  contradictions — including over `""`, which no atom can hold — planning
  `never`; `is` decided against the queried Type; every unknown shape (`is …
  in`, `like`, comparisons, lone `has` or `!`, `""` and set literals,
  `if-then-else`, junk) weakened with its reason; weakening narrowing under
  AND and swallowed under OR;
- responses: errored and decided plans; permits combined; a forbid that
  always holds planning `never`, one that never holds dropping out, any
  other costing exactness — and a forbid merely weakened to `true` not
  mistaken for one that always holds; `unless`; a still-constrained scope;
  the `unverified-attribute-types` rule with and without the assertion,
  omitted or malformed;
- an **attack** case where `always OR` a weakened subterm, or an
  always-holding permit beside a possibly-erroring one, is not claimed exact;
- a property check over 4,000 generated residuals of the shapes strict
  validation admits, against a reference evaluator of Cedar's semantics:
  every allowed object admitted, and exactly those wherever a plan claims
  exactness (over 500 exact plans checked), plus 2,000 permit/forbid pairs;
- the real engine's plans for each demo rule; a principal Cedar can't
  evaluate — mistyped, non-JSON, or empty — planning `never`;
- differential conformance against Cedar's own decisions: no violation on
  well-typed data with or without the assertion, and, pinned, mistyped data
  breaking only the assertion — sound either way;
- the runtime: Cedar planned, Cedar conformant-planned, Cedar unplanned, and
  ABAC planned returning the same objects for every identity and query,
  walked page by page; a clinician's aggregate refused without the
  assertion and equal to ABAC's with it; the explain report naming the
  limitation; the airforce domain planning exactly.

The decision parity suite now hides both planners, so it still compares
every decision.

**Found while building this, and fixed in ADR-0038's ABAC planner.** Under
Cedar's semantics `X || true` is not `true` when `X` errors, and the same
held for `anyOf`, which stopped at a throwing alternative: `anyOf(rule that
throws, requireRole("staff"))` denied staff yet planned `always`, exact. Now
an alternative that throws is one that doesn't allow, and a later one still
can — the OR's semantics, and what makes `always OR opaque` exact in any
order. `checkPlanConformance` treats a throwing `evaluate` as a deny, and the
ABAC conformance cases include throwing rules in every position. For Cedar,
where an error anywhere denies the whole request, any weakened subterm keeps
the plan inexact.

Mutation-checked (14 mutations): planning an errored response, an
always-holding forbid, or a non-trivial forbid as anything but what it is;
ignoring weakening; dropping the contradiction rule, the `is` type check, the
`unless` inversion, or the scope check; accepting a non-identifier atom;
dropping the attribute-type rule; treating a lone `has` as implied; a
default-true `schemaConformantData`; planning `never` on any failed partial
evaluation; and `anyOf` letting a throw end the OR — each fails the suites.

## Context

ADR-0038 made authorization planning part of the `PolicyEngine` contract and
gave the embedded ABAC engine a planner. `CedarPolicyEngine` (ADR-0031) has
none, so every Cedar-guarded query reads every row and decides each one
after the read: the pagination channel stays open, aggregation over
row-scoped Types stays refused, and switching engines in the demo visibly
costs both.

Cedar can say what a policy set admits when part of a request is unknown:
`isAuthorizedPartial`, in the pinned `@cedar-policy/cedar-wasm` 4.13.0,
evaluates everything it knows and returns, per policy, the condition left
over — a *residual* — in Cedar's JSON expression format. With the principal
and action known and the resource unknown, the residuals are exactly the
question a plan answers. Cedar treats partial evaluation as experimental, so
the design must not trust its output shape beyond what it can check.

Probing the demo policy set shows what the residuals look like. The
clinician rule `resource has assignedClinicianId && …
resource.assignedClinicianId != "" && resource.assignedClinicianId ==
principal.providerId` comes back as `has(resource.assignedClinicianId) &&
!(resource.assignedClinicianId == "") && resource.assignedClinicianId ==
"PR-2001"`; a scope `resource is T` comes back as an `is` test; `unless`
comes back folded into `!`; a `forbid` comes back as a residual with its
effect; a principal whose attributes don't match the schema fails the whole
call, as it fails every full evaluation.

Two facts decide the design. ADR-0038's predicate language is positive, so a
residual's `has` and `!` must either be simplified away exactly or replaced
by `true`. And Cedar refuses any request whose resource carries a declared
attribute of the wrong type — even one no policy reads (ADR-0031's pinned,
fail-closed divergence) — which no store filter can express.

## Decision

**1. `CedarPolicyEngine.plan()` from partial evaluation.** The principal and
its roles are mapped exactly as for `evaluate`; the resource is unknown. The
answer becomes a plan:

- any policy that errored — an error independent of the resource, so every
  full evaluation would error, and deny — plans `never`;
- a decided `allow` plans `always`, a decided `deny` plans `never`;
- otherwise, the permits' residuals are combined with `anyPlan`, and the
  forbids' are checked: one whose condition holds for every resource plans
  `never`; one that holds for none drops out; any other can only *exclude*
  objects, which the positive language can't say, so it is left to the
  post-read check and the plan records `negated-condition`.

A failed partial evaluation plans `never` only if the full type-level
request fails too — a principal Cedar can't evaluate at all; any other
failure is a planner failure, which ADR-0038 already turns into `unknown`.

**2. Residuals translate by shape, and anything else is `true`.**
`&&` and `||` become `allPlans` and `anyPlan`; `true` and `false` become
`always` and `never`; `resource.a == v` (either way round) with `v` a
non-empty string or a number becomes an `eq` atom; `resource is T` is
decided against the queried Type. Within a conjunction that already pins
`resource.a == c`, `has resource.a` and `!(resource.a == d)` for `d ≠ c` are
implied and drop out exactly, and `!(resource.a == c)` makes it `never`.
Every other shape — `like`, comparisons, `in`, `if-then-else`, a remaining
`!` or `has`, an entity or set literal, a shape this version doesn't know —
becomes `true` with the limitation `unrepresentable-condition`. Because it
replaces the whole subterm, in a position under only `&&` and `||`, that is
always a weakening: sound.

**3. Declared attribute types: exact only if the data is asserted to
conform.** Cedar denies an object whose declared attributes are mistyped,
and nothing in a plan can exclude it. So a plan for a Type that declares
resource attributes is marked inexact — limitation
`unverified-attribute-types` — unless the engine is built with
`schemaConformantData: true`: the deployment's assertion that its store only
holds values of the schema's types (typed columns, check constraints,
validated writes). `never` stays exact either way. With the assertion and a
malformed row, the post-read check still drops it and the runtime records a
plan defect (ADR-0038); an aggregate, which has no post-read check, would
count it.

**4. New limitation codes, engine-neutral.** `unrepresentable-condition`
(part of a policy's condition has no predicate form), `negated-condition`
(a condition that excludes objects), and `unverified-attribute-types` (the
engine denies mistyped objects the store can't filter out) join ADR-0038's
list.

## Consequences

- Cedar-guarded queries push the policy into the adapter's filter and read
  only what the policy could allow; Types without declared resource
  attributes (the airforce Types, the hospital Provider and Appointment)
  plan exactly.
- For the hospital Patient, Cedar plans are inexact by default, so pages
  can still come back short and a clinician's aggregate is still refused
  under Cedar; with `schemaConformantData: true` they are exact and match
  ABAC's.
- The parity suite compares decisions with both planners hidden, and a
  planning-parity suite compares ABAC-planned and Cedar-planned results.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **Partial evaluation is experimental upstream.** The translator trusts
  only the shapes it recognizes and weakens the rest; a changed residual
  format degrades plans toward `unknown`, never toward hiding data — but
  upgrading `cedar-wasm` should re-run the conformance suites.
- **`schemaConformantData` is an assertion, not a check.** Set it only
  where the store enforces the schema's types.
- **`forbid`s cost exactness.** A policy set that relies on `forbid` to
  narrow reads gets inexact plans until the predicate language gains
  negation.

## Alternatives Considered

- **Translate Cedar policy text directly.** Re-implements Cedar's
  semantics; partial evaluation is Cedar applying its own.
- **Add `not` and `exists` to the predicate language now.** They would let
  `forbid` and bare `has` stay exact, but weakening under a negation admits
  less, so every weakening rule would have to know its polarity, and no
  shipped adapter's filter DSL has either operator. The simplification in
  point 2 already makes the demo's rules exact.
- **Treat Cedar's type refusal as out of contract and claim exactness.**
  An aggregate would count objects Cedar refuses to show; the assertion
  makes that a deployment's explicit choice instead.
- **Filter on attribute types in the store.** The filter DSL has no type
  test, and adding one to every adapter is ADR-0040's territory.
