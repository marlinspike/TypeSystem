---
"@typesys/adapter-postgres": minor
---

Provable numeric pushdown (ADR-0044). Numeric filter conditions no longer compare as `float8` or claim exactness: they compile to supersets bounded in exact `numeric` arithmetic by the exact decimal values of the filter number's neighboring doubles, which is sound whatever Postgres's floating-point input does, and are re-checked with `matchesFilter`. A filter with a numeric condition is paged in JavaScript. String, boolean, and `null` equality stay exact.
