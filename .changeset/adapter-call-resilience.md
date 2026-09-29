---
"@typesys/core": minor
"@typesys/adapter-mock-rest": minor
"@typesys/adapter-postgres": minor
---

Adapter-call resilience (ADR-0026): every adapter call the runtime makes can now be given a per-call timeout with cooperative `AbortSignal` cancellation, retries with exponential backoff and jitter for idempotent reads (and only those Actions whose `idempotency` is not `"none"`), and a per-data-source circuit breaker. Opt in with `SemanticRuntimeOptions.resilience` (or the exported `RECOMMENDED_RESILIENCE_POLICY`); omitting it preserves prior behavior exactly. Adds `AdapterCallOptions` (an optional trailing `{ signal }` on every `Adapter` method), the `AdapterTimeoutError` / `AdapterUnavailableError` / `CircuitOpenError` errors, and `isRetryableError`. The mock-REST adapter honors the signal on its simulated latency; the Postgres pool's default `max` is raised to 20 to match the runtime's default concurrency budget, with an opt-in `PG_STATEMENT_TIMEOUT_MS`.
