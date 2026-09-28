# 0024. Production-Readiness Gap — Documented, Not Closed

## Status

Accepted

## Context

By this point the codebase has 23 prior ADRs, real tests against a real
PostgreSQL instance, real cross-adapter combinations (including Postgres
paired with a second, different real adapter), a real OIDC/JWT identity
resolver, and a real HTTP transport. It is, by the measure this whole
project has used throughout — build it for real, test it for real,
document it honestly — a solid reference implementation of the
architecture it sets out to prove.

None of that makes it safe to point real production traffic at. Asked
directly ("how useful is this tool really," "what would it take to make
this production-ready"), the honest answer turned out to be a specific,
ranked list, not a vague "needs more hardening." That list is worth
recording the same way every other real decision in this codebase is —
discoverable from `docs/why-typesys.md`'s "don't use it when" section and
`docs/completeness.md`, not left as a one-off answer in a conversation
that disappears once the session ends.

## Decision

Record the gap as a ranked, concrete list, and explicitly decide **not**
to attempt closing any of it in this pass.

### Tier 1 — blocking, before any real traffic touches it

1. **Replace the policy engine, or prove it's enough.**
   `AbacPolicyEngine` (`packages/core/src/policy/abac-policy-engine.ts`,
   ADR-0009) is a hand-rolled `Map<policyName, PolicyRule>` — the entire
   security boundary of this system runs through it. Fine for a vertical
   slice; never reviewed for real authorization complexity (rule
   conflicts, an audit trail for changes to the *rules themselves*, a
   real threat model). Swap for OPA/Cedar (the seam ADR-0009 explicitly
   left for this), or get someone whose job is security to actually
   attack the one that's here.
2. **Real load testing.** `npm run benchmark` (ADR — none, it's a script)
   measures a synthetic 200-item fleet on one laptop. Nothing here says
   what happens at real concurrency, with real adapter latency, with
   `Cache`/`RateLimiter` (ADR-0016/ADR-0019) actually under contention —
   and cross-source computed properties have a *measured* ~10x cost
   cliff (ADR-0022's Consequences) that has never been stress-tested at
   scale.
3. **A real multi-instance story.** `InMemoryCache` and
   `InMemoryRateLimiter` are per-process by design (ADR-0016/ADR-0019);
   `PostgresRegistryStore`'s own ADR-0015 accepted an
   "unverified-at-scale multi-instance story," a caveat ADR-0016 repeats
   rather than resolves. Running more than one replica today rests on an
   unverified assumption, not a tested guarantee.
4. **Per-instance authorization, if the real domain needs it.** Every
   policy rule in this codebase is role-based at the Type/property level
   — "any `clinician` can read any `Patient`," never "this clinician can
   read *this* patient." Flagged explicitly when building
   `domain-hospital` (`packages/domain-hospital/src/setup.ts`'s
   comments) as a deliberate simplification, not a proven-sufficient
   design. Most real deployments need the per-instance version.
5. **Secrets management.** `DATABASE_URL`, JWKS endpoints, `NPM_TOKEN` —
   every credential in this codebase is "an environment variable that is
   assumed to just be there." A real deployment needs a real secrets
   manager and a rotation story; neither exists here.

### Tier 2 — operational maturity

6. **Observability wired to something real.** The OpenTelemetry hooks
   (ADR-0017) are tested to fire correctly in isolation; nobody has
   pointed them at a real backend (Datadog, Honeycomb, Jaeger) and built
   dashboards, alerts, or SLOs on the resulting signals.
7. **Migration and rollback discipline.**
   `adapter-postgres`/`registry-store-postgres` migrations are tested as
   "safely re-runnable" (ADR-0015); there is no rollback story, no
   staging/prod parity check, no zero-downtime playbook.
8. **Rate-limiter tuning.** `InMemoryRateLimiter`'s token-bucket
   mechanics (ADR-0019) are correct; nobody has picked real
   capacity/refill numbers against real traffic. That's a tuning
   exercise against real load, not a code task.
9. **On-call readiness.** No runbooks, no alerting on policy-deny spikes
   or audit-log anomalies, no operator-facing error taxonomy beyond "read
   the thrown error's class name." `AuditEvent` (the audit trail) exists;
   nothing consumes it operationally yet.

### Tier 3 — packaging and domain

10. **A real decision on publishing.** Every `@typesys/*` package is
    still `0.1.0` with pending, unconsumed changesets (ADR-0020). Fine as
    an internal fork; an actual `npm install`-able dependency needs real
    semver discipline exercised over time and a real maintenance
    commitment, neither of which a single build-out pass can establish.
11. **A real domain, not the demo ones.** `domain-airforce` and
    `domain-hospital` exist to prove the architecture is domain-neutral
    (ADR-0013) — they are not meant to be deployed. Whatever a real
    deployment actually runs needs its own Types, policies, and adapters,
    written and reviewed with the same rigor, not reused wholesale from
    either demo domain.
12. **Dependency/supply-chain review**, and — since the original mission
    brief frames a DoD/federal example domain — very likely a real
    compliance/ATO process that supersedes everything above for that
    specific context. Organizational, not architectural; out of scope
    for this ADR to attempt.

### Why not start closing some of this now

Every item above is only meaningful when done against real requirements,
real traffic, or a real threat model. None of that exists for a reference
implementation with no production deployment. Doing any of this
speculatively — inventing rate-limiter numbers, running a "security
review" with no adversarial pressure and the same author who wrote the
code, wiring observability to a backend nobody actually watches — would
produce false confidence, which is a worse position than an honest,
visible gap.

## Consequences

- Anyone evaluating this codebase for production use has one canonical,
  linked place to check first, instead of inferring the gap from scattered
  hedges across several docs.
- This is a living list, not a one-time snapshot: when an item is
  actually closed for real (against real requirements, not a speculative
  pass), update this ADR's own text to say so, and reflect it in
  `docs/completeness.md` too — the same discipline that document already
  holds itself to for every other capability.
- Nothing in this ADR changes any code, test, or existing capability
  claim. It is purely a recorded, ranked assessment.

## Alternatives Considered

- **Fold this into `docs/completeness.md` instead of a new ADR**:
  rejected — `completeness.md`'s own stated scope is "what's built and
  tested versus a documented extension point" for the *architecture as
  it exists*. This is a different question — "is it safe to run this
  specific reference implementation against real traffic" — and merging
  the two would blur what `completeness.md` is actually for. A cross-link
  between the two is the right relationship, not a merge.
- **Close a couple of the "easy" items now** (wire OTel to a real
  backend, pick rate-limiter numbers) to show visible progress: rejected
  — see "Why not start closing some of this now," above. Speculative
  hardening produces false confidence, not real readiness.
- **Say nothing beyond `docs/why-typesys.md`'s existing "don't bet
  production traffic on this" line**: rejected — that line names the
  *stance* but not the *list*, which is the actually useful, actionable
  part for anyone deciding whether and how to invest in closing this gap.
