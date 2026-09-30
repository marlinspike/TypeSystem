# How to enable observability

There is nothing to "turn on" in this codebase — every `SemanticRuntime`
method is already instrumented. `@typesys/core` depends on
`@opentelemetry/api` only, never an SDK, so every span/metric call is a
free no-op until *your application* registers a real provider
([ADR-0017](../adr/0017-observability.md)). This page is about that one
step, done in your app's entrypoint, not in this codebase.

## Register a real SDK

```ts
import { trace, metrics, context } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"; // or sdk-trace-base + your own processors
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

// Without this, span parent/child nesting across `await` silently doesn't work — see
// the note in packages/core/test/observability.test.ts if traces look flat when they shouldn't.
context.setGlobalContextManager(new AsyncHooksContextManager().enable());

trace.setGlobalTracerProvider(new NodeTracerProvider({
  spanProcessors: [/* a BatchSpanProcessor wrapping OTLPTraceExporter, etc. */]
}));

metrics.setGlobalMeterProvider(new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })]
}));
```

Do this once, before your application starts handling requests. Nothing
in `@typesys/core`, `@typesys/mcp-server`, or `@typesys/demo-web` needs to
know this happened — they call `trace.getTracer()`/`metrics.getMeter()`
at module load time regardless, and the OTel API's proxy tracers/meters
find your real provider once it's registered, even though `import`
happened first.

## What you'll see

**Spans**, one per `SemanticRuntime` method call
(`SemanticRuntime.getObject`, `.getRelationship`, `.query`,
`.getProvenance`, `.listActions`, `.invokeAction`), each with:

- `typesys.type_name`, `typesys.object_id` (when applicable)
- the caller, per the `telemetryIdentity` option
  ([ADR-0045](../adr/0045-telemetry-identity-policy.md)):
  `typesys.identity.subject_id` under `"clear"` (the default), nothing under
  `"none"`, or `typesys.identity.pseudonym` — an HMAC of the subject id
  under a key you supply, at least 32 bytes — under
  `{ mode: "pseudonymous", key }`. Traces travel further than the audit log;
  choose accordingly. Audit rows always keep the subject id.
- `typesys.action_name` (for `invokeAction`)
- `typesys.cache.hit` (`true`/`false`) on any cache-aware call
- an `exception` event + ERROR status if the call threw

Nested calls (e.g. `getRelationship`'s fan-out to `getObject` per related
object) produce real parent/child spans, not flat siblings — you can see
the actual N-way concurrency from
[the N+1 fix](../architecture.md) in a trace waterfall.

MCP requests get one top-level span too —
`mcp.resources/read`/`mcp.tools/call` — with the runtime's own spans
nesting underneath, so a single trace shows the whole
agent-call → runtime → adapter chain.

**Metrics**: `typesys.policy.decisions` (counter, by `decision`),
`typesys.cache.requests` (counter, by `result`), and
`typesys.operation.duration` (histogram, by `operation`/`type_name`).

## Audit stays separate, on purpose

Traces/metrics are ephemeral, sampled, and entirely absent if you skip
this page. The audit log (`registry.listAuditEvents()`) is durable,
queryable, and — with `@typesys/registry-store-postgres` — immutable at
the database level. Telemetry is for "why is this slow." Audit is for
"who was denied access to what, and when." Never treat a trace as the
record of a security decision.

## Verify it

Register an in-memory-exporter SDK exactly as
[`packages/core/test/observability.test.ts`](../../packages/core/test/observability.test.ts)
does, run a request, and read the exported spans back — that test is
itself the executable proof this works, not just documentation of intent.
