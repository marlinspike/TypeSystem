# 0024. Production-Readiness Gap: Documented, Not Closed

## Status

Accepted

## Context

By this point the codebase has 23 prior ADRs, real tests against a real
PostgreSQL instance, real cross-adapter combinations (including Postgres
paired with a second, different real adapter), a real OIDC/JWT identity
resolver, and a real HTTP transport. It is, by the measure this whole
project has used throughout (build it for real, test it for real,
document it honestly), a solid reference implementation of the
architecture it sets out to prove.

None of that makes it safe to point real production traffic at. Asked
directly ("how useful is this tool really," "what would it take to make
this production-ready"), the honest answer is a specific, ranked list,
not a vague "needs more hardening." That list is worth recording the same
way every other real decision in this codebase is: discoverable, and kept
current, not left as a one-off answer in a conversation that disappears
once the session ends.

## Decision

Record the gap, and explicitly decide **not** to attempt closing any of
it in this pass.

The ranked list itself lives in
[`../PRODUCTION-READINESS.md`](../PRODUCTION-READINESS.md), not in this
ADR. That split is deliberate: the list is expected to change as items
are genuinely closed, and an accepted ADR is a durable record of a
decision, not a living checklist. This ADR records the decision and its
reasoning; the readiness document holds the current list and is
cross-linked from [`../completeness.md`](../completeness.md) and
[`../why-typesys.md`](../why-typesys.md).

### Why not start closing some of it now

Every item on that list is only meaningful when done against real
requirements, real traffic, or a real threat model. None of that exists
for a reference implementation with no production deployment. Doing any
of it speculatively (inventing rate-limiter numbers, running a "security
review" with no adversarial pressure and the same author who wrote the
code, wiring observability to a backend nobody actually watches) would
produce false confidence, which is a worse position than an honest,
visible gap.

## Consequences

- Anyone evaluating this codebase for production use has one canonical,
  linked place to check first
  ([`PRODUCTION-READINESS.md`](../PRODUCTION-READINESS.md)), instead of
  inferring the gap from scattered hedges across several docs.
- The readiness list is a living document: when an item is actually
  closed for real (against real requirements, not a speculative pass),
  update `PRODUCTION-READINESS.md` and reflect it in `completeness.md`.
  This ADR does not change, because the decision it records (document the
  gap rather than close it speculatively) does not change when an
  individual item is later closed on its own merits.
- Nothing in this ADR changes any code, test, or existing capability
  claim. It is purely the decision to record and rank the gap.

## Alternatives Considered

- **Keep the ranked list inline in this ADR** (the original form of this
  ADR): rejected. An accepted ADR is conventionally immutable; a ranked
  readiness checklist embedded in one goes stale precisely because the
  ADR is not supposed to be rewritten. Splitting the durable decision
  (here) from the living list (`PRODUCTION-READINESS.md`) keeps each in
  the form it should take.
- **Fold this into `completeness.md` instead of recording a decision at
  all**: rejected. `completeness.md`'s own stated scope is "what is built
  and tested versus a documented extension point" for the architecture as
  it exists. "Is it safe to run this specific reference implementation
  against real traffic" is a different question, and the decision to
  document-not-close is worth recording as a decision. A cross-link among
  the three documents is the right relationship, not a merge.
- **Say nothing beyond `why-typesys.md`'s existing "don't bet production
  traffic on this" line**: rejected. That line names the stance but not
  the list, which is the actually useful, actionable part for anyone
  deciding whether and how to invest in closing the gap.
