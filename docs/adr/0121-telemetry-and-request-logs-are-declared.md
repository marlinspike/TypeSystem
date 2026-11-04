# 0121. Telemetry and Request Logs Are Declared

## Status

Accepted (2026-11-04). Implemented in `packages/host/src/telemetry.ts`,
`packages/host/src/serve.ts` and `runtime.telemetry` / `runtime.requestLog` in
`packages/host/src/deployment.ts`. Proven by
`packages/host/test/telemetry.test.ts`.

## Context

The runtime is instrumented against the OpenTelemetry API (ADR-0017), which
records nothing until a provider is registered, and only code could register
one. The generic server wrote no line per request, so an operator had nothing
to read when a caller reported an error.

## Decision

- `runtime.telemetry: { otlpEndpoint, serviceName?, metricsIntervalSeconds? }`
  registers the SDK with OTLP/HTTP exporters for traces and metrics. The
  resource names the service, the deployment and its build id. Closing the
  server flushes what is buffered, waiting at most five seconds. The SDK is
  loaded only when the deployment declares it. Core's metric instruments are
  made again when the global provider changes, because a meter taken before
  a provider is registered stays a no-op (the API has no proxy meter).
- The generic host runs the runtime with `telemetryIdentity: "none"`: no object
  or subject id is put on a span.
- Every request is logged as one JSON line on stdout with its time, level
  (by status), deployment, build, request id, method, route, status and
  duration. The route has object and workflow-run ids and long segments
  replaced, and no query string; no header, token or value is logged.
  Successful health checks are not logged. `runtime.requestLog: false` turns
  it off.
- A caller's `X-Request-Id` is kept when it is a plain token (letters, digits,
  `.`, `_`, `-`, at most 64), otherwise a new one is made; either is echoed.

## Consequences

An operator gets traces, metrics and an access log by adding an endpoint to the
deployment, without code. Correlating a span with an object needs the audit
trail, which records it under policy.
