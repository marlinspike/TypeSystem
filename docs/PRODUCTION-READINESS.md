# Production readiness

This is the living, ranked assessment of what stands between this
reference implementation and real production traffic. It is meant to
change: when an item is genuinely closed, against real requirements and
not a speculative pass, edit it here and reflect it in
[`completeness.md`](completeness.md).

Three documents divide the work of being honest about this codebase.
[`completeness.md`](completeness.md) says what is built and tested versus
a documented seam, for the architecture as it exists.
[ADR-0024](adr/0024-production-readiness-gap.md) records the decision to
document this gap rather than close it, and why closing it speculatively
would be worse than leaving it visible. This file is the list itself, the
part that goes stale if it lives inside an accepted ADR, so it lives here
and is expected to move.

The stance, restated: every item below is only meaningful against real
requirements, real traffic, or a real threat model. None of it should be
closed speculatively. Inventing rate-limiter numbers, running a security
review with no adversarial pressure and the same author who wrote the
code, or wiring observability to a backend nobody watches would produce
false confidence, which is a worse position than an honest, visible gap.

## Gating context: federal / DoD accreditation

For the DoD example domain this project frames (see
[`initial_prompt.md`](initial_prompt.md)), a real
authorization-to-operate (ATO) process supersedes and reorders everything
below against the controls that actually apply (NIST 800-53 / RMF, and a
real dependency and supply-chain review). It is organizational rather
than architectural and out of scope for this repo to attempt, but it is
named first because it gates the rest: in an accredited context, none of
the tiers below are independently "done" until the accreditation boundary
says so.

## Tier 1: blocking, before any real traffic

1. **Replace the policy engine, or prove it is enough.**
   `AbacPolicyEngine` (`packages/core/src/policy/abac-policy-engine.ts`,
   ADR-0009) is a hand-rolled `Map<policyName, PolicyRule>`, and the
   entire security boundary of the system runs through it. Fine for a
   vertical slice; never reviewed for real authorization complexity (rule
   conflicts, an audit trail for changes to the rules themselves, a real
   threat model). Swap for OPA/Cedar (the seam ADR-0009 left), or have
   someone whose job is security actually attack the one that is here.
2. **A hostile-input threat model at the boundary.** The HTTP transport
   (ADR-0021) and the `query` DSL tool (ADR-0011) accept external input,
   and nothing here has been reviewed for injection, resource exhaustion,
   or malformed-input behavior. This belongs next to the policy engine,
   not unlisted. *Partially addressed:* `SemanticRuntime` now validates
   query shape and bounds (`QueryLimits`) and Action input against each
   `inputSchema` (`packages/core/src/runtime/input-validation.ts`). That is
   input hygiene, not a threat model; the review itself is still open.
3. **Data classification enforcement.** `ProvenanceRef` carries a
   `classification` field and `x-provenance` a `defaultClassification`,
   but the runtime does not read either back or enforce
   classification-aware handling (ADR-0008; `architecture.md` notes
   `x-provenance` is not yet wired into behavior). For classified or PHI
   data this is blocking, not a nice-to-have.
4. **Encryption in transit and at rest.** Not addressed anywhere. Secrets
   management (item 6) is a subset of this, not a substitute: TLS
   termination, database-at-rest encryption, and key management each need
   a real answer.
5. **Real load testing.** `npm run benchmark` measures a synthetic
   200-item fleet on one laptop. Nothing says what happens at real
   concurrency, with real adapter latency, with `Cache`/`RateLimiter`
   (ADR-0016/ADR-0019) actually under contention, and cross-source
   computed properties have a measured ~10x cost cliff (ADR-0022) never
   stress-tested at scale.
6. **Secrets management.** `DATABASE_URL`, JWKS endpoints, `NPM_TOKEN`:
   every credential is "an environment variable that is assumed to just
   be there." A real deployment needs a real secrets manager and a
   rotation story; neither exists here.
7. **A real multi-instance story.** `InMemoryCache` and
   `InMemoryRateLimiter` are per-process by design (ADR-0016/ADR-0019),
   and `PostgresRegistryStore` (ADR-0015) accepted an
   "unverified-at-scale multi-instance story." Running more than one
   replica today rests on an unverified assumption, not a tested
   guarantee.
8. **Per-instance authorization, if the real domain needs it.** Every
   policy rule here is role-based at the Type/property level ("any
   `clinician` can read any `Patient`"), never "this clinician can read
   *this* patient." Flagged as a deliberate simplification in
   `packages/domain-hospital/src/setup.ts`, not a proven-sufficient
   design. Most real deployments need the per-instance version.

## Tier 2: operational maturity

9. **Audit integrity and retention.** The audit trail is append-only,
   enforced by a DB trigger (ADR-0015), which is a good start, but there
   is no tamper-evidence beyond append-only, no export, and no retention
   policy. Under an accreditation boundary this escalates to Tier 1.
10. **Observability wired to something real.** The OpenTelemetry hooks
    (ADR-0017) are tested to fire in isolation; nobody has pointed them at
    a real backend (Datadog, Honeycomb, Jaeger) and built dashboards,
    alerts, or SLOs on the signals.
11. **Migration and rollback discipline.**
    `adapter-postgres`/`registry-store-postgres` migrations are tested as
    safely re-runnable (ADR-0015); there is no rollback story, no
    staging/prod parity check, no zero-downtime playbook.
12. **Rate-limiter tuning.** `InMemoryRateLimiter`'s token-bucket
    mechanics (ADR-0019) are correct; nobody has picked real
    capacity/refill numbers against real traffic. That is a tuning
    exercise against real load, not a code task.
13. **On-call readiness.** No runbooks, no alerting on policy-deny spikes
    or audit-log anomalies, no operator-facing error taxonomy beyond the
    thrown error's class name. `AuditEvent` exists; nothing consumes it
    operationally yet.

## Tier 3: packaging and domain

14. **A real decision on publishing.** Every `@typesys/*` package is still
    `0.1.0` with pending, unconsumed changesets (ADR-0020). Fine as an
    internal fork; an `npm install`-able dependency needs real semver
    discipline over time and a real maintenance commitment, neither of
    which a single build-out pass can establish.
15. **A real domain, not the demo ones.** `domain-airforce` and
    `domain-hospital` exist to prove the architecture is domain-neutral
    (ADR-0013); they are not meant to be deployed. A real deployment needs
    its own Types, policies, and adapters, written and reviewed with the
    same rigor, not reused wholesale.
16. **Dependency and supply-chain review.** Rolled into the federal
    accreditation note above where that context applies, but a baseline
    dependency and supply-chain review is worth doing regardless of
    deployment context.

## When an item is actually closed

Update this file (move the item, or strike it with a dated note on how it
was closed and against what requirement), and reflect the change in
[`completeness.md`](completeness.md). Do not edit
[ADR-0024](adr/0024-production-readiness-gap.md): the decision it records,
document the gap rather than close it speculatively, is unchanged when an
individual item is later closed on its own merits.
