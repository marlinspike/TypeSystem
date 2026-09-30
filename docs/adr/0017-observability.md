# 0017. OpenTelemetry Instrumentation

## Status

Accepted. *Amended by ADR-0045:* how much caller identity spans carry is a
policy — `"none"`, `"clear"` (the default), or a keyed pseudonym. *Amended
by ADR-0047:* the same policy covers object ids and span error messages,
and the tracer is looked up per span.

## Context

The original standards research (folded into ADR-0001 through ADR-0014's
decisions at the time) concluded OpenTelemetry is the right layer for
observing the semantic runtime itself — query latency, action execution,
cache hit rate, policy decisions — but explicitly *not* a substitute for
this project's own first-class provenance model, since OTel has no
convention for "which source system produced this value" and was never
meant to. That conclusion was recorded; the instrumentation was never
built. At small scale this is invisible. At the scale this question is
actually about, it's a real gap: nothing in this codebase currently
answers "why is this query slow," "what's our cache hit rate," or "which
adapter is timing out" — every one of the last three architectural
additions (Postgres, caching, concurrent relationship fan-out) created
exactly the kind of behavior an operator would want visibility into, and
none of it is currently visible.

## Decision

### Depend on `@opentelemetry/api`, never an SDK

`@typesys/core` depends on `@opentelemetry/api` only — the thin,
zero-behavior interface package (tracer/meter/span types), not
`@opentelemetry/sdk-trace-base`/`sdk-metrics` or any exporter. This is the
standard way a library instruments itself without forcing an observability
stack (or a specific vendor, or any behavior at all) onto every consumer:
`@opentelemetry/api` ships a global no-op tracer/meter by default, so
every span/metric call in this codebase is a cheap no-op — no spans
created, no memory held, no behavioral change whatsoever — unless the
*application* embedding this runtime registers a real SDK
(`NodeTracerProvider`, a Prometheus/OTLP exporter, whatever it chooses).
A small project that never sets any of this up pays nothing and sees
nothing different. A large deployment that wires up its existing
OTel collector gets real traces and metrics from this runtime for free,
because the instrumentation was already there waiting for a provider to
attach to.

### Spans wrap every `SemanticRuntime` public method; metrics are counters + one histogram

`packages/core/src/observability/tracing.ts` exports a `withSpan(name, attributes, fn)`
helper built on `tracer.startActiveSpan`; `SemanticRuntime.getObject`,
`getRelationship`, `query`, `getProvenance`, `listActions`, and
`invokeAction` are each wrapped, with attributes: `typesys.type_name`,
`typesys.object_id` (when applicable), `typesys.identity.subject_id`,
`typesys.action_name` (for actions), and `typesys.cache.hit` (`true`/
`false`/absent for `"live"` resolution) set on the relevant span. A thrown
error calls `span.recordException` and sets an error `SpanStatus` before
propagating — the span always reflects what actually happened, including
failures.

`packages/core/src/observability/metrics.ts` exports three instruments via
a lazily-created `Meter`:

- `typesys.policy.decisions` (counter, labeled `decision: allow|deny`) —
  every `evaluate()` call increments this, mirroring (never replacing) the
  durable audit log.
- `typesys.cache.requests` (counter, labeled `result: hit|miss`) — from the
  ADR-0016 cache-aware paths.
- `typesys.operation.duration` (histogram, labeled `operation`,
  `type_name`) — wall-clock time for each traced runtime method.

### Audit stays canonical; telemetry is operational, not a security record

Nothing here changes `RegistryStore.appendAuditEvent`/`listAuditEvents`.
Audit is the durable, queryable, immutable (ADR-0015) record of every
policy decision — required to survive, required to be queryable months
later. Telemetry is the opposite on purpose: ephemeral, sampled at the
exporter's discretion, and entirely absent if no SDK is registered. A
span attribute mirrors a policy decision for trace-correlation
convenience (so an operator debugging a slow trace can see it was also
denied, without a second lookup) — but the audit log, not a trace, is the
answer to "who was denied access to what, and when," exactly as before.

### The MCP server gets one top-level span per request, not separate instrumentation

`packages/mcp-server/src/resources.ts`/`tools.ts` wrap each handler body in
`withSpan("mcp.resources/read", ...)` / `withSpan("mcp.tools/call", ...)`.
Because both call straight into the same `SemanticRuntime`, this produces
one coherent trace per MCP request — `mcp.tools/call` as the parent span,
`SemanticRuntime.invokeAction` and whatever adapter/cache work it does
underneath as children — rather than a second, parallel instrumentation
scheme for the MCP transport. This is the same "don't re-implement
governance for a transport-specific layer" principle ADR-0012 already
established, applied to observability instead of policy.

## Consequences

- Zero cost, zero setup, zero new infrastructure for any project that
  doesn't ask for it — `@opentelemetry/api`'s no-op default is what makes
  this true, and is the entire reason this dependency choice (API package
  only, never an SDK) was worth being explicit about.
- A large deployment gets real distributed tracing across
  web/MCP → runtime → adapter → (Postgres/external system) by wiring up
  one SDK once, at its own process boundary — nothing in this codebase's
  own packages needs to change to benefit from it.
- Span/metric attribute names (`typesys.*`) are this project's own
  convention, not borrowed from OTel's semantic-conventions package for
  GenAI/database calls — those conventions target LLM/DB client
  instrumentation specifically and don't have a natural slot for "semantic
  type," "resolution mode," or "policy decision." Revisit if OTel ever
  publishes conventions for a semantic/ontology layer specifically.

## Alternatives Considered

- **Depending on a full OTel SDK directly**: rejected — it would force a
  specific export destination (or at least a specific SDK version/config
  shape) onto every consumer of `@typesys/core`, including ones that don't
  want OpenTelemetry at all. The API-only dependency is what makes this
  purely additive.
- **Building a custom lightweight metrics/tracing system instead of
  OpenTelemetry**: rejected — this is exactly the kind of infrastructure
  the mission brief's non-goals warn against building from scratch
  ("prefer established standards... make architectural decisions [rather
  than] blindly using a technology"), and OpenTelemetry is already the
  answer the original research concluded was correct for this exact
  layer.
- **Replacing the audit log with OTel spans**: rejected, explicitly — see
  Decision above. Sampling, exporter buffering, and "no SDK registered at
  all" are all normal, expected states for telemetry and would each be a
  silent security-audit gap if spans were the only record.
- **Auto-instrumenting adapters too** (wrapping every `Adapter` call in a
  span inside `SemanticRuntime`, generically): considered, deferred — the
  runtime-level spans already show adapter call *duration* as part of
  their own span (the adapter call happens inside the traced method), so
  the marginal value of a second, adapter-specific span per call is real
  but smaller; adapters are also free to instrument themselves directly
  (they're just classes implementing an interface) if a specific adapter's
  author wants finer-grained spans. Not required for this pass to be
  useful.
