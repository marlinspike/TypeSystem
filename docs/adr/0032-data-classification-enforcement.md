# 0032. Data Classification Enforcement

## Status

Accepted. *Amended by ADR-0041:* schemes now `decide` whole labels for whole
subjects and `join` the labels of derived data, and the runtime decides the
join and every marking on its own; `dominates` is gone.

Accepted — implemented in `@typesys/core` (`runtime/classification.ts`:
`ClassificationScheme`, `linearClassification`, `US_CLASSIFICATION`; the
checks in `runtime/runtime.ts`; `Identity.clearance` and
`XProvenance.properties[].classification` in the model), in
`@typesys/auth-oidc` (`clearanceClaim`), and in the airforce demo
(`Aircraft.deploymentLocation`, SECRET). Proven by:

- `packages/core/test/data-classification.test.ts` — the scheme's ordering
  and its fail-closed edges (missing, unknown, and case-mismatched
  clearances; unknown markings); object markings (denied with a generic
  reason, the adapter never called for an uncleared `getObject` or `query`,
  related objects dropped, a classified relationship refused); value
  redaction from declared and provenance markings; transitive derivation,
  including a derivation whose source a policy hid first; composition with
  property policy, and a permissive policy engine unable to relax it; an
  **attack** block over projection, includes, `includeProvenance`,
  `getProvenance` (declared, value-level, derived), filter / sort / search /
  aggregate probes on declared markings, value-level probes (items dropped),
  Actions and `listActions`, and a sweep asserting no classified value or
  marking reaches an uncleared caller by any path; the audit rows (allow and
  deny, with `details`, none for unmarked data); and a throwing scheme and a
  compartmented lattice through the same interface.
- `packages/domain-airforce/test/data-classification.test.ts` and
  `packages/mcp-server/test/data-classification.test.ts` — the demo field
  over the runtime and over MCP, including a maintainer the policy allows
  but classification doesn't.
- `packages/auth-oidc/test/oidc-identity-resolver.test.ts` — `clearanceClaim`
  mapping, and no clearance without it.
- `packages/policy-cedar/test/parity.test.ts` still passes with the
  classified Aircraft: both engines see the same redactions, because
  classification never goes through either.

Mutation-checked: removing any one of the object, member, value,
derivation, probe, search, query-gate, aggregate, provenance, or Action
checks, letting a throwing scheme allow, or deciding classification after
policies instead of before, fails the suite.

**Amended by ADR-0034:** `US_CLASSIFICATION` is renamed
`DEMO_LINEAR_CLASSIFICATION` (it is not the US model), and the runtime's
default is now the explicit `DENY_MARKED_DATA` — marked data is denied until
a scheme is configured — rather than the demo ordering. Point 2 below
describes the original default.

**Amended 2026-09-30 — an audit-completeness defect, found in review and
fixed.** `listActions` computed its `authorized` flags correctly but through
the non-auditing primitives: the clearance check through `dominates()`
(breaking point 4 below) and the policy check through `decide()` (unaudited
since before ADR-0030). It now runs the same private gate as
`invokeAction` — `authorizeInvoke()`: the policy through `evaluate()`, then,
only if that allows, the clearance through `clearedFor()` — so it writes
exactly the decision rows an invocation's gates write, and its answers are
unchanged. `packages/core/test/data-classification.test.ts` pins the rows
for allow and deny on a marked Type and their equality with
`invokeAction`'s; `packages/core/test/audit-completeness.test.ts` is a
tripwire over every call site of the non-auditing primitives. Point 4 is
also made precise: it covers every *decision*, which selecting a default
search's properties is not.

## Context

Classification markings already have two homes in the model, and the
runtime reads neither. `ProvenanceRef.classification` lets an adapter mark
an individual value (ADR-0008 says no adapter sets it yet), and a Type's
`x-provenance.defaultClassification` lets an author mark a whole Type;
`semantic-meta-model.md` says outright that `x-provenance` is "not wired
into a behavior." `PRODUCTION-READINESS.md` item 3 calls this blocking for
classified or PHI data, which is this repo's federal target: a label that
is carried but never enforced is worse than no label, because it looks like
a control.

Classification is not an authorization rule in the ABAC sense. It is a
mandatory control: a subject's clearance must dominate the data's marking,
whatever any policy says, and it must hold whichever `PolicyEngine` is
plugged in (ADR-0031 made that engine swappable). It also has semantics
ABAC rules don't: markings are ordered, the unknown is treated as the most
restrictive, and data derived from a classified value is itself classified.

## Decision

**1. Clearance on the identity, markings on the data.** `Identity` gains
`clearance?: string`. Markings are read from three places, all optional:
the Type's own `x-provenance.defaultClassification` (the *object's*
classification); a member's `x-provenance.properties[name].classification`
(a property's or relationship's, a new field beside `authoritativeSource`);
and each value's `ProvenanceRef.classification`, as the adapter returned
it. Unmarked data is unclassified, which keeps every existing Type readable
exactly as before.

**2. A pluggable ordering, fail-closed by construction.** A
`ClassificationScheme` answers one question — `dominates(clearance,
marking)` — so a lattice with compartments or caveats can be plugged in
through `SemanticRuntimeOptions.classification`. The default,
`US_CLASSIFICATION`, is `linearClassification(["UNCLASSIFIED", "CUI",
"SECRET", "TOP_SECRET"])`: a missing or unrecognized clearance holds only
the lowest level, and an unrecognized marking (a typo, a foreign scheme's
label) is dominated by no one. There is no "off": the default scheme is
always in force, so a marking an author writes is always enforced.

**3. Enforced once, at `SemanticRuntime`, beside the policy engine — never
through it.** Both must pass; neither can relax the other.

- **Objects.** The object's marking is checked before any adapter call:
  an uncleared caller never causes a classified object to be read.
  `getObject` and a relationship's source and targets deny (a denied target
  is dropped, as ADR-0030 drops one the policy denies); `query` returns an
  empty page without calling the adapter; `aggregate` is refused. Actions on
  a classified Type are refused, and `listActions` reports them unauthorized,
  since an Action's result is data of that Type.
- **Values.** In `finalizeValues`, a property is redacted if any of its
  *effective* markings is not dominated — its declared marking, its value's
  provenance marking, and, for a computed property, every marking of every
  dependency, recursively. Derived data inherits its inputs' classification.
  Markings are decided over every resolved value *before* property policies
  remove any, so a computed value can't escape because its source happened
  to be hidden for another reason first.
- **Probes.** A top-level filter, sort, or search, or an aggregation, that
  names a property marked above the caller's clearance is refused, as a
  hidden policy-gated property already is (ADR-0027) — it runs in the
  adapter against unredacted values. A value marked by its *provenance* is
  only known after the adapter returns, so a query item whose filtered,
  sorted, or searched property turned out to be classified out is dropped:
  the item was selected or ordered by a value the caller can't see. That
  holds even when another disjunct of an `or` (a default search) matched —
  which one did can't be told without the hidden value. Default search
  properties exclude those the *schema* marks above the caller.
- **Provenance.** `getProvenance` requires clearance for the object, the
  property's declared marking, and the value's provenance marking; a
  computed property's provenance requires every dependency's. Provenance of
  a redacted value is never returned by `includeProvenance`, which already
  lists only visible properties.

**4. Audited like any other decision.** Every classification *decision* on
marked data — a check whose outcome grants or refuses the caller access,
or tells the caller what they may do (`listActions`) — writes an audit row
(allow or deny), with `details: { control: "classification", markings,
clearance }` so a reviewer can tell it from a policy decision. Choosing
which properties a default search ranges over is query planning, not a
decision: a skipped field is never read or matched, every value the search
returns is decided (and audited) in `finalizeValues`, and it writes nothing. The reason returned to a caller is generic — "Requires a
higher clearance" — and never names a marking, since a value-level marking
can itself be sensitive. A scheme that throws denies, as a policy engine
that throws does (ADR-0030).

**5. Identity from a real token.** `@typesys/auth-oidc` gains an optional
`clearanceClaim` (a claim path, like `rolesClaim`); unset, no clearance is
mapped and the subject reads only unclassified data.

**6. The demo.** `airforce.Aircraft` gains `deploymentLocation`, marked
`SECRET`. The Maintainer is cleared `SECRET` and sees it; the Viewer is
cleared `CUI` and gets the Aircraft without it — beside `maintenanceStatus`,
which the Viewer loses to a policy instead. Two controls, one read.

## Consequences

- Markings an author or adapter writes are enforced on every read path,
  independently of the policy engine, and fail closed on anything
  unrecognized.
- A Type-level marking makes its objects cost nothing for an uncleared
  caller: no adapter call, one audited deny.
- Audit volume grows with the amount of *marked* data read — one row per
  marked object and per marked property decision. Unmarked data adds none.
- Classification propagates through computed properties; policies don't
  (a policy author gates a computed property explicitly). That asymmetry is
  deliberate: classification is mandatory and follows the data, a policy is
  a rule about a named member.
- Markings are exact strings. `"secret"` is not `"SECRET"`, and is readable
  by no one under the default scheme.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **The scheme is a starting point, not an accreditation.** Real US
  markings carry dissemination controls and compartments (`NOFORN`, SCI,
  SAP) that a linear order can't express; CUI has categories. Implement
  `ClassificationScheme` for the markings your data actually carries, and
  have it reviewed.
- **Value-level markings can't reach adapter-side aggregation.** `aggregate`
  runs in the adapter and only the schema's markings are checked before it;
  a sum over a property whose *values* an adapter marks higher will include
  them. Declare the ceiling in the schema for any property that can hold
  classified values. The same holds for the pagination inference channel
  ADR-0030 records: a dropped item still shortens its page.
- **Clearance is only as trustworthy as the identity provider** that
  asserts it (`clearanceClaim`), and the demo token map hands out clearances
  to anyone holding a demo token.
- **No write rules.** This is read enforcement (simple security, "no read
  up"). It does not implement a `*`-property ("no write down"): a cleared
  subject can still invoke an Action that writes into a less-classified
  Type.
- **Markings on base types and traits are not inherited.** Only a Type's own
  `x-provenance` is read; confirm every classified Type declares its own.
- **Spillage handling, marking banners, and declassification** are out of
  scope.
- **Audit rows record the decision, not the operation.** A `listActions`
  preview writes the same rows an `invokeAction` gate does; they are told
  apart only by the outcome row an executed Action adds. Alerting on
  "invoke denials" must account for previews, or the rows must gain the
  runtime operation that made them. *Closed by ADR-0042:* every row names
  its operation.

## Alternatives Considered

- **Express classification as ABAC policies** (a rule comparing
  `subject.clearance` to `resource.attributes.classification`, ADR-0030).
  It works for per-record markings, but it makes a mandatory control
  depend on every policy author remembering it and on whichever engine is
  plugged in — a Cedar policy set without it would simply not enforce it.
  A control beside the engine can't be forgotten or swapped out.
- **A high-water-mark object classification** (the object is as classified
  as its most classified property). Standard for document banners, but it
  would make any object with one SECRET field unreadable to a CUI-cleared
  caller, where portion-level redaction serves them everything else.
  Portion marking is what the per-property marking models.
- **Leave unmarked data unreadable until marked** (default-deny on missing
  markings). The most conservative choice, and a breaking change to every
  existing Type and deployment. Unmarked stays unclassified; the review
  item above covers confirming every classified Type is marked.
- **Make enforcement opt-in** (no scheme, no checks). Rejected: that is
  today's behavior, the gap this ADR exists to close. A marking that is
  written must be enforced.
- **Per-record object markings** (a stored field naming each object's own
  classification). A real need in classified systems; deferred as a
  follow-up — it needs a declared marking attribute and a decision on how it
  combines with the Type marking. Until then it can be expressed as a
  row-level policy (ADR-0030), with the caveat above.
