# 0034. Classification Scheme Naming and Default Semantics

## Status

Accepted — implemented in `@typesys/core` (`runtime/classification.ts`:
`DEMO_LINEAR_CLASSIFICATION`, `DENY_MARKED_DATA`, named schemes, and
list-valued `objectMarkings` / `memberMarkings` / `valueMarkings`; the
default resolved once in `SemanticRuntime`'s constructor), with the airforce
testbed, the Cedar parity suite, and the web demo configuring the demo scheme
explicitly. Proven by:

- `packages/core/test/classification-defaults.test.ts` — `DENY_MARKED_DATA`
  dominates nothing for any clearance and marking, and is frozen; an
  **attack** block where classification is left unconfigured four ways (no
  options, `{}`, `classification: undefined`, `classification: null`) and
  marked objects, members, provenance-marked values, derived values, probes,
  provenance, aggregation, and Actions all stay closed to a TOP_SECRET
  reader while unmarked data reads as before; an unusable scheme object
  denying rather than failing open; only a configured, dominating scheme
  opening the data; audit rows naming the deciding scheme; and unmarked data
  never asking the scheme.
- `packages/domain-airforce/test/data-classification.test.ts` — the airforce
  Types on a runtime built with no scheme hide `deploymentLocation` even from
  the Maintainer.
- The ADR-0032 suite, renamed onto `DEMO_LINEAR_CLASSIFICATION`, still
  passes, as does the Cedar parity suite with the scheme configured on both
  sides.

Mutation-checked: a permissive default, a `DENY_MARKED_DATA` that allows,
asking the scheme about unmarked data, dropping the scheme from the audit
row, or letting an unusable scheme allow each fails the suites.

## Context

ADR-0032 made classification a mandatory control and shipped one scheme,
`US_CLASSIFICATION = linearClassification(["UNCLASSIFIED", "CUI", "SECRET",
"TOP_SECRET"])`, as the runtime's default. Review found two problems with
that, one of naming and one of semantics.

**The name claims a model the scheme doesn't implement.** Real US
classification markings carry compartments (SCI, SAP), dissemination
controls (NOFORN, REL TO), and more, none of which a linear order can
express. And CUI is not a rung on the classified ladder at all: it is a
separate regime (32 CFR Part 2002), governed by category and lawful
government purpose rather than by clearance level. Ordering it between
UNCLASSIFIED and SECRET is a useful demonstration and a wrong model.
Calling the scheme `US_CLASSIFICATION` invites exactly the misreading the
repository's honesty documents exist to prevent. Nothing has been published
(ADR-0020), so the rename costs nothing now and would be breaking later.

**A default that decides.** Because `US_CLASSIFICATION` was the default, a
deployment that never configured a scheme silently got its semantics — and
any Type marked in that vocabulary became readable by anyone holding the
matching string clearance. "Forgot to configure classification" should
never mean "classification configured for you." At the same time, the
alternative must not be that an *absent* option carries security meaning
through the runtime: `undefined` flowing through decisions is how fail-open
bugs are written.

## Decision

**1. Rename: `DEMO_LINEAR_CLASSIFICATION`.** The same ordering, named for
what it is and documented as a demonstration that is *not* the US model.
`linearClassification(levels, name)` stays the factory, and its schemes
expose their `levels` so a UI can draw them.

**2. An explicit default: `DENY_MARKED_DATA`.** The runtime's default
scheme is a real, named scheme object whose `dominates` is always `false`.
Its semantics are the invariant this ADR exists for:

- unmarked data → allowed (no marking, so no decision is asked);
- marked data → denied, whatever the reader's clearance.

`SemanticRuntimeOptions.classification` resolves once, at construction, to
either the scheme passed in or `DENY_MARKED_DATA`; from then on the runtime
only ever holds a concrete scheme. Classification enforcement cannot be
disabled by forgetting to configure it: marked data stays unreadable until a
deployment chooses a scheme that can dominate its markings.

**3. Markings are lists, never `undefined`.** Inside the runtime, "unmarked"
is an empty list of markings, not an absent value: `objectMarkings` and
`memberMarkings` return `string[]`, a value's provenance marking joins the
list only when present, and a decision is asked only of a non-empty list. No
decision path branches on `undefined` to mean "allowed."

**4. Schemes are named, and the name is audited.** `ClassificationScheme`
gains a required `name`, and every classification audit row records it in
`details.scheme`. An operator looking at a wall of denials can see at once
that they came from `deny-marked-data` — "no scheme configured" — rather than
from a real clearance mismatch.

**5. Domains that mark data configure a scheme.** The airforce testbed marks
`deploymentLocation` SECRET in the demo vocabulary, so it now passes
`DEMO_LINEAR_CLASSIFICATION` explicitly; so do the Cedar parity suite and the
web demo. A deployment building its own runtime over those Types without a
scheme gets `DENY_MARKED_DATA` — and a test proves the Maintainer then
cannot read the field.

## Consequences

- A marked Type with no configured scheme is unreadable for everyone. That is
  the intended failure mode, visible in audit rows as `details.scheme:
  "deny-marked-data"`.
- `US_CLASSIFICATION` is gone, not aliased: an alias would keep the
  misleading name alive.
- Custom schemes must now declare a `name`.
- Unmarked data behaves exactly as before under every scheme, the default
  included.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **Choosing a scheme is still the deployment's job,** and neither shipped
  scheme is a real classification or CUI model. ADR-0041 is where the model
  itself evolves; until then, a deployment with real markings needs its own
  reviewed `ClassificationScheme`.
- **`DENY_MARKED_DATA` can turn a missing configuration into an outage** for
  every marked Type. That is the right direction to fail; make sure it shows
  up in pre-production testing, not first in production.

## Alternatives Considered

- **No default at all — refuse to construct a runtime without a scheme.**
  Loud, but it breaks every runtime whose data is entirely unmarked, which
  needs no scheme. A deny-marked default is equally safe and only affects
  deployments that actually mark data.
- **Refuse to construct when a registered Type is marked but no scheme was
  passed.** The registry is dynamic (types register after construction, and
  a Postgres registry is shared across replicas), so construction can't know;
  the per-decision default covers every case.
- **Keep `undefined` as "deny marked data" inside the runtime.** The same
  behavior, but it spreads a security meaning onto an absent value through
  every code path that touches it. One named object, resolved once, is
  auditable and testable on its own.
- **Keep `US_CLASSIFICATION` as a deprecated alias.** It would preserve the
  misleading name in every codebase that copied it. Nothing is published, so
  there is nobody to break.
