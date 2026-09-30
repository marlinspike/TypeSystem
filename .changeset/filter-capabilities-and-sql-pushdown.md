---
"@typesys/core": minor
"@typesys/encryption": minor
"@typesys/adapter-postgres": minor
---

Adapter filter capabilities and SQL pushdown (ADR-0040). `Adapter` gains an optional `canFilter(typeName, property, operator)`; when fitting an authorization plan the runtime pushes an atom only where it answers `true` (or, without it, on unprotected fields), recording the new `unfilterable-attribute` limitation otherwise. `EncryptingAdapter.canFilter` answers `true` for `eq`/`ne`/`in` on deterministic fields, so row-level plans over them are exact. `PostgresRepositoryAdapter` now compiles `queryByType` and `aggregate` filters to parameterized JSONB SQL — exactly (GIN-indexed `@>` for strings, booleans, and `null`; `float8` comparisons for numbers) or as a superset (`contains`, `icontains`) — re-checks every row with `matchesFilter`, and pages in SQL when the filter is exact and unsorted.
