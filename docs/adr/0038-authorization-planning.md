# 0038. Authorization Planning

## Status

*Amended by ADR-0039:* `anyOf` now treats an alternative that throws as one
that doesn't allow, so `always OR opaque` is exact in any order; before, a
throwing alternative ended the OR, and the plan overclaimed exactness.

Accepted — implemented in `@typesys/core`: the plan types, constructors,
combinators, and checks in `policy/authorization-plan.ts`;
`PolicyEngine.plan?` in `model/policy.ts`; ABAC planning from the combinator
tree in `policy/abac-policy-engine.ts`; fitting, `query` and `aggregate` use,
defect detection, `rowSecurity`, and `explainQuery` in `runtime/runtime.ts`;
and `checkPlanConformance` in `testing/plan-conformance.ts`, a
framework-agnostic differential check any planner can be held to. Proven by:

- `packages/core/test/authorization-plan.test.ts` — constructors enforcing
  exactness; simplification recovering it (`never AND unknown`, `always OR
  unknown`); `checkPlan` rejecting every malformed shape and every plan whose
  exactness contradicts its limitations; generated-case properties showing
  that pushdown to the filter DSL is an equivalence (2,000 cases, prototype
  keys and `"7"`/`7` included), that weakening any atoms — a disjunct
  included — only admits more, and that refitting to itself changes nothing;
  the ABAC planner's shape for every combinator and wrong-shaped subject
  value; and differential conformance over 13 subjects, 81 objects, and 9
  policies with no violation — plus the harness catching a planner that
  hides data, one that overclaims exactness, and one that fails.
- `packages/core/test/authorization-planning.test.ts` — the exact plan in
  the adapter's filter, ANDed with the caller's; full pages where
  post-filtering returned an empty one; `never` without an adapter call and
  one audited deny; every admitted object still decided; aggregation over
  exactly the readable rows, audited, and an **attack** block where unknown,
  never, weakened, inexact-predicate, and failed-planner plans all still
  refuse; protected and cross-source attributes weakened with the rows only
  they admit still returned; planner defects (thrown, malformed,
  overclaimed) falling back to `unknown`; an exact plan admitting denied
  objects caught, audited, and dropped; the under-approximation residual
  pinned; `require-exact` refusing every inexact case with an audited deny
  and a message free of attribute values, and failing on a detected defect;
  and `explainQuery`'s report, guarantees, and literal-free audit row.
- `packages/domain-hospital/test/authorization-planning.test.ts` — on the
  hospital domain with edge-case patients and 11 identities: the patient
  policy conformant; every query, walked page by page at three page sizes,
  returning exactly what a runtime deciding every row returns; pages full;
  and each identity's aggregate equal to the number of patients it can read.
- `packages/core/test/observability.test.ts` — the query span carries the
  plan's kind, exactness, and limitation codes, and neither the predicate's
  literal nor the attribute it tests.
- The ADR-0030 suites, updated: post-filter behavior now pinned with an
  unplannable copy of the rule, and plan behavior beside it; the Cedar parity
  suite comparing Cedar with ABAC's decisions, planner hidden; the
  encryption transparency suite pinning the one divergence — a clinician's
  aggregate over the encrypted `assignedClinicianId`.

Found while verifying this in the web demo, and fixed: a method-proxying
decorator turned `sensitiveFields` into a Promise the runtime couldn't read,
so the demo's encrypted `assignedClinicianId` was pushed as a filter (see the
ADR-0036 amendment). A declaration may now be async, and a malformed one
protects every field; both paths are pinned in the caching and planning
suites. The demo's guardrails cover both sides: a clinician's count refused
over the encrypted attribute, a patient's counted exactly — 23 of 23 as
designed under ABAC and under Cedar.

Mutation-checked (34 mutations): in the combinators, dropping `never`
absorption, `unknown` swallowing an OR, or `always` absorption, losing
limitations in an AND, a predicate plan always exact, accepting inconsistent
exactness or an empty identifier, pushing `ne` for `eq`, refitting an OR as
an AND, and ignoring the exact flag; in ABAC, a missing subject value
planning `always`, testing the subject's attribute name, swapping `anyOf`
and `allOf`, inverting a role, an opaque rule planning `never`, and an
unregistered policy planning `always`; in the runtime, not weakening
cross-source or protected attributes, dropping a plan's own limitations when
fitting, trusting an unchecked plan, skipping the `require-exact` refusal,
the `never` short-circuit, the caller's filter, defect detection, the
exactness check or the predicate on aggregation, the `require-exact` defect
failure, the probe condition on pagination privacy, or the `rowSecurity`
validation; and in reading declarations, accepting a non-name, swallowing a
throw as "nothing protected", not awaiting an async answer, or ignoring
protected fields for computed values — each fails the suites.

## Context

Row-level authorization (ADR-0030) decides every object on its own stored
attributes, after the adapter has read it. `query` asks the adapter for a
page, then drops the rows the caller may not read. That is correct — nothing
unauthorized is ever returned — but it has three costs ADR-0030 recorded and
left open:

- **Pagination leaks.** A clinician asking for 20 patients gets a page of 3
  and a cursor. The shortfall says how many unreadable patients sat in that
  window, and walking cursors enumerates the Type's size.
- **Aggregation is refused.** `aggregate` is a type-level request: the
  adapter aggregates every row, so a rule that depends on the object's own
  attributes can't allow it. A clinician can't count *their own* patients.
- **Every row is read.** The adapter does the work of loading rows only to
  have them dropped.

The fix is to turn the policy into a filter the adapter applies before it
reads: an *authorization plan*. The danger is equally clear. A filter that
admits less than the policy allows silently hides data the caller is
entitled to; a filter kept separately from the policy drifts from it. So the
design has to make both impossible where it can, and visible where it
can't.

## Decision

**1. The contract: a plan is a sound over-approximation.** For every
subject, whatever the policy would allow, the plan admits. Three cases
follow:

- an **exact** plan admits exactly what the policy allows — safe and
  complete;
- an **inexact** plan admits more — still safe, because the post-read check
  remains;
- a plan admitting **less** is a defect: it hides authorized data, and
  nothing downstream can notice.

The post-read `evaluate()` on every returned object stays, permanently,
including under exact plans. It is what makes an inexact plan safe and what
catches a wrong exact one.

**2. The shape.** In `@typesys/core`, with no dependency on any engine:

```ts
type AuthorizationPlan =
  | { kind: "always" }
  | { kind: "never" }
  | { kind: "predicate"; predicate: AuthorizationPredicate; exact: boolean; limitations: AuthorizationPlanLimitation[] }
  | { kind: "unknown"; limitations: AuthorizationPlanLimitation[] };

type AuthorizationPredicate =
  | { attribute: string; eq: string | number }
  | { and: AuthorizationPredicate[] }
  | { or: AuthorizationPredicate[] };
```

`always` and `never` are exact by definition; `unknown` admits everything
and says why. The predicate language is deliberately **positive** — no
`not` — so replacing any part of it with `true` can only admit more, which
is what keeps weakening sound (point 5). An `eq` atom holds exactly when the
object's stored attribute is that identifier, compared strictly: the same
test `requireAttributeMatch` applies, and the same `===` the query filter
DSL applies, so pushing an atom down is an equivalence, not an
approximation. Negation and attribute existence come with Cedar (ADR-0039),
whose `forbid` and `has` need them.

**3. Limitations are structured.** Every reason a plan is not exact is a
value, never text:

| code | meaning |
|---|---|
| `engine-cannot-plan` | the policy engine has no planner |
| `opaque-rule` | the rule, or part of it, is a plain function |
| `planner-failed` | the planner threw or returned something malformed |
| `protected-attribute` | the adapter protects the attribute at rest, so the store can't filter on it |
| `cross-source-attribute` | the attribute comes from another data source (ADR-0023) than the one listing the Type |

**4. `exact` is explicit and constructor-enforced.** Plans are built only
through `predicatePlan`, `unknownPlan`, `ALWAYS`, `NEVER`, and the
combinators `allPlans` / `anyPlan`: a predicate plan is exact exactly when
it has no limitations. A plan an engine returns is validated; one that is
malformed or claims exactness it can't have is a planner defect (point 7).
The combinators simplify with exactness recovery: `never AND anything` is
`never`, and `always OR anything` is `always` — exact, whatever the other
side's limitations — while `unknown` inside an `and` weakens to `true` and
inside an `or` swallows it.

**5. Engines plan; ABAC plans from the rules it evaluates.**
`PolicyEngine.plan?(request)` is optional; an engine without it gets
`unknown` / `engine-cannot-plan`, and behaves exactly as before.
`AbacPolicyEngine` plans from the same combinator tree it evaluates, so on
that path the filter can't drift from the policy: `allowAllRule` is
`always`; `requireRole` is `always` or `never` from the subject's roles;
`requireAttributeMatch` is an `eq` atom with the subject's value substituted,
or `never` when the subject has no usable value; `anyOf` and `allOf` combine
their children. A plain function rule is `unknown` / `opaque-rule`, and an
unregistered policy — which denies everything — is `never`.

**6. The runtime fits a plan to where the data is.** The adapter that lists
the Type filters on its own stored values, which are exactly what the policy
decides on — with two exceptions. An atom on an attribute from an override
data source (ADR-0023), or one the base adapter protects at rest
(`sensitiveFields`, ADR-0036), is replaced by `true` and records a
limitation: replaced, never dropped, since dropping a disjunct would admit
less. Every other atom is pushed as it is; one naming a computed property
matches nothing in the store, as it matches nothing in the stored attributes
the policy sees.

**7. How `query` and `aggregate` use it.**

- `query`: `never` returns an empty page without calling the adapter,
  auditing one deny row for the Type; a predicate is ANDed into the
  adapter's filter and audited once, as an allow naming the plan, since the
  objects it excludes are never decided one by one; `always` and `unknown`
  run as before. Every returned object is still evaluated and audited. The
  plan's attributes are not probes (ADR-0032): they select nothing the
  policy wouldn't have decided on anyway.
- `aggregate`: the type-level decision stays first and unchanged. When it
  denies, an **exact** predicate plan admits the aggregation over exactly
  the rows the caller may read — the predicate ANDed into the aggregate's
  filter before the adapter aggregates — and is audited as an allow naming
  the plan. An inexact plan, `unknown`, or `never` still refuses. This
  needs no SQL pushdown (ADR-0040): the adapter applies the filter however
  it applies any other.
- A **plan defect** — an object the post-read check denies under an exact
  plan — is audited as its own deny row and counted.

**8. `rowSecurity`: `"post-filter"` (default) or `"require-exact"`.**
Resolved once at construction. Under `post-filter`, a planner that fails
falls back to `unknown`, and a detected defect drops the object as the
post-read check always has. Under `require-exact`, a query whose plan isn't
exact is refused with `AuthorizationPlanError` (an `AuthorizationError`),
and so is a query in which a defect is detected. A broader strict preset may
imply it later.

**9. Diagnostics: `runtime.explainQuery()`, runtime-only and audited.** It
returns the fitted plan, its limitations, and the guarantees that follow:
`exact`, `paginationPrivate` (exact, and nothing but classification can
drop a row — a probed value's own provenance marking still can, and is
listed), `aggregationSafe`, and `postFilterRequired`. It is not an MCP tool:
a plan reveals which attributes a policy tests and the caller's own values.
Spans and audit rows carry only the plan's kind, exactness, and limitation
codes — never predicate literals or identity values.

## Consequences

- For a Type whose policy the planner can express exactly, a page holds
  every readable row it can and the shortfall channel closes; the adapter no
  longer reads rows the caller can't see; and callers can aggregate over the
  rows they may read.
- An adapter whose `queryByType` misapplies the filter DSL would now return
  fewer rows than the policy allows, where before it only affected the
  caller's own filters. The filter DSL was already every adapter's contract,
  and every shipped adapter evaluates it with the same `matchesFilter`
  whose equivalence to the predicate the property tests prove.
- Objects a plan excludes are never read, so they are never decided and
  never audited one by one; a `never` plan writes one row for the query.
- Cedar runtimes plan `unknown` and behave exactly as before until
  ADR-0039.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **Soundness of every planner is the whole game.** ABAC's is proven by a
  differential test over generated subjects and objects; a custom
  `PolicyRule` with a hand-written `plan` is only as sound as its author.
- **Weakening on protected fields** makes the demo's encrypted
  `assignedClinicianId` plan inexact: deterministic fields could be
  filtered through their blind index, but saying which fields an adapter
  can filter is ADR-0040's.
- **`explainQuery` reveals policy structure**; keep it off any surface an
  untrusted caller can reach.

## Alternatives Considered

- **Separate filter definitions beside each policy.** Two definitions of one
  rule drift; the planner reads the rule itself.
- **Depend on Cedar partial evaluation for everything.** It would leave the
  embedded engine unplanned and tie the contract to one engine's
  experimental feature; ADR-0039 plugs Cedar into this contract instead.
- **Drop the post-read check under exact plans.** It is cheap, it is what
  catches a wrong planner, and "exact" is a claim, not a proof.
- **Negation in the first predicate language.** Weakening a negated term
  toward `true` admits *less* under the negation; a positive language keeps
  every weakening sound by construction.
- **Allow aggregation under inexact plans.** The aggregate would count rows
  the caller can't read; there is no post-read check on a sum.
