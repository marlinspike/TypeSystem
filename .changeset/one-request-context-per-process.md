---
"@typesys/core": patch
---

`SemanticRuntime` shares one `AsyncLocalStorage` per process for its request context instead of creating one per instance. On Node 22 each live `AsyncLocalStorage` is propagated on every promise and never released, so every runtime constructed slowed every later `await` in the process. Each request context names its runtime, so instances still keep separate concurrency budgets and audited operations.
