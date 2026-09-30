# 0040. Adapter Filter Capabilities and SQL Pushdown

## Status

Accepted — implemented as `Adapter.canFilter?` and plan fitting in
`@typesys/core`, `EncryptingAdapter.canFilter` in `@typesys/encryption`, and
the filter compiler (`src/sql-filter.ts`) behind `queryByType` and
`aggregate` in `@typesys/adapter-postgres`, with the new limitation
`unfilterable-attribute`. Proven by:

- `packages/adapter-postgres/test/sql-pushdown.test.ts`, against a local
  PostgreSQL 17: every property name and value bound as a parameter; exact
  and superset marking per operator, `NaN` and non-number bounds compiled to
  `FALSE`; a differential check of 400 generated filters over 150 generated
  rows — values chosen where JSONB and JavaScript part ways (`"7"`/`7`,
  `0.1+0.2`, `1e21`, `Straße`, `İstanbul`, nested arrays, `null`, `__proto__`
  and quote-laden keys) — walked page by page at three page sizes, returning
  exactly `matchesFilter`'s rows, with full pages and no trailing empty page
  wherever the compiler claims exactness; the same with sorts; an exact
  filter paging in SQL; a superset narrowing in SQL and decided in
  JavaScript; aggregates over exactly the filtered rows; a number stored
  with more precision than a double matching as JavaScript reads it; an
  **attack** block of injection attempts in names and values, leaving the
  table intact; and string equality answerable from the GIN index.
- `packages/core/test/authorization-planning.test.ts` — a capability answer
  pushing a protected attribute exactly, a "no" weakening an unprotected
  one, and an **attack** block where junk, truthy non-`true` answers, and a
  throw never push.
- `packages/encryption/test/encrypting-adapter.test.ts` — the adapter's
  answers per mode and operator, and a clinician's aggregate over the
  encrypted `assignedClinicianId` now identical encrypted or not, under an
  exact plan; ADR-0038's pinned divergence is gone.

Mutation-checked (16 mutations): dropping `COALESCE`, comparing as
`numeric`, a comparison marked a superset, `contains` or `icontains` marked
exact, `in` or `ne` on a non-array or non-matching value compiled the wrong
way, dropping the `NaN` guard, OR's exactness from `some`, an empty AND as
`FALSE`, skipping the JavaScript re-check, paging a superset in SQL, an
off-by-one cursor, a truthy capability answer, pushing protected attributes
without asking, and an `EncryptingAdapter` claiming equality on randomized
fields — each fails the suites.

## Context

ADR-0038 pushes a read policy into the adapter's filter, but only as far as
the runtime can tell the adapter will evaluate it. Two gaps remain.

**The runtime can't tell what an adapter can filter.** It knows only which
fields an adapter protects at rest (ADR-0036), and weakens every atom on
one. For the `EncryptingAdapter` that is too cautious: a deterministic field
*can* be filtered by equality, through its blind index, exactly. So the
hospital's clinician rule, which tests the encrypted but deterministic
`assignedClinicianId`, plans inexactly: a clinician's pages can come back
short and their aggregate is refused — the one divergence the encryption
transparency suite pins.

**The Postgres adapter doesn't push anything down.** `queryByType` and
`aggregate` load every row of the Type and filter in JavaScript. A pushed
plan narrows *what the runtime decides*, not what the database reads. With
row-level plans now in every query's filter, that is the difference between
a clinician's query touching their patients and touching all of them.

Pushdown to SQL has a correctness trap the plan contract makes sharp: SQL
that excludes a row `matchesFilter` would keep is an *under-approximation*
— it hides data, and nothing downstream notices. JSONB and JavaScript
disagree at the edges: numeric precision, array containment, Unicode case
folding, collation.

## Decision

**1. `Adapter.canFilter?(typeName, property, operator)`.** Whether
`queryByType` evaluates a condition on that property — with an identifier
value — exactly as `matchesFilter` does. Absent, an adapter is taken to
honor the filter DSL for every field it doesn't protect, as it always has
had to. When fitting a plan (ADR-0038), an atom is pushed if the adapter
says it can filter it, or — without an answer — if the field isn't
protected; otherwise it is weakened to `true`. As with `sensitiveFields`, the
answer may be async, and anything but `true` — including a throw — is "no".
`EncryptingAdapter` answers `true` for `eq`, `ne`, and `in` on deterministic
fields, `false` for any other operator on an encrypted field, and defers to
the adapter it wraps for everything else.

**2. The Postgres adapter compiles the filter to SQL, exactly or as a
superset.** Every condition becomes a parameterized predicate over the
`values` JSONB column — property names and values are bound parameters,
never interpolated — marked either *exact* (it selects exactly the rows
`matchesFilter` would) or a *superset* (it selects at least those):

| condition | SQL | |
|---|---|---|
| `eq` a string, boolean, or `null` | `values @> {"p": v}` (GIN-indexed) | exact |
| `eq` a finite number | `jsonb_typeof = 'number' AND (values->>p)::float8 = v` | exact |
| `eq` anything else | `FALSE` — `===` never matches a fresh array or object | exact |
| `ne` | `NOT` of `eq`'s predicate | exact |
| `in` | `OR` of `eq` over the array's elements; `FALSE` if it isn't an array | exact |
| `gt` `gte` `lt` `lte`, finite number | `jsonb_typeof = 'number' AND (values->>p)::float8 op v` | exact |
| `contains`, `icontains` | the property's JSON type only | superset |
| `and` / `or` | the same, over the parts | exact iff every part is |

Numbers compare as `float8` because that is what `JSON.parse` produces:
parsing a stored decimal to a double is the same IEEE rounding in both, so
SQL and JavaScript agree on every comparison, where `numeric` would compare
more precisely than the JavaScript that decides. `contains` and `icontains`
stay supersets because JSONB array containment and Postgres case folding
don't match JavaScript's.

**3. JavaScript still decides.** Every row the SQL returns is re-checked
with `matchesFilter`, so a superset is only ever narrowed, never trusted.
When the whole filter compiles exactly and the query has no `sort`, `ORDER
BY object_id`, `LIMIT`, and `OFFSET` run in SQL and a page reads only its
rows; otherwise the adapter reads the SQL-filtered rows and sorts and pages
in JavaScript, as before — the same order and cursors either way.
`aggregate` narrows with the same SQL before aggregating in JavaScript.

## Consequences

- A clinician's plan over the encrypted `assignedClinicianId` is exact, so
  their pages are full and their aggregate runs — encrypted or not. The
  encryption transparency suite no longer pins a divergence.
- A Postgres-backed query reads only the rows its filter — the caller's and
  the plan's — could match, through the existing GIN index for string,
  boolean, and `null` equality.
- `canFilter` is one more optional method a decorator must forward.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **The compiler is a security boundary now.** An exact predicate that
  excluded a matching row would hide data the caller may read. It is proven
  by a differential test against `matchesFilter` over generated filters and
  rows on a real PostgreSQL, but a new operator must add its own row to the
  table above and to that test.
- **Values written around the adapter.** A number stored with more
  precision than a double, or outside its range, can only come from a write
  that bypasses the adapter; such a row may compare differently, or make the
  cast fail loudly.
- **Performance is not measured here.** Numeric and range conditions aren't
  indexed; a high-volume Type still wants its own table and adapter (the
  package README's advice stands).

## Alternatives Considered

- **Translate every condition exactly, or not at all.** Refusing to push
  `contains`/`icontains` would read every row for any search; a superset plus
  a re-check narrows safely.
- **Compare numbers as `numeric`.** More precise than the JavaScript that
  decides, and so able to exclude a row JavaScript keeps.
- **Declare capabilities as a static table on the adapter.** Capabilities
  depend on the Type and field (an `EncryptingAdapter`'s config), so a
  function of both is the smallest honest shape.
- **Trust the SQL and drop the JavaScript re-check.** Cheap insurance, and
  it is what lets a superset be correct at all.
