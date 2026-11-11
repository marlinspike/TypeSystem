# 0122. Postgres Table Queries Run in SQL

## Status

Accepted (2026-11-11). Implemented in `packages/adapter-postgres/src/table-sql.ts`
and `packages/adapter-postgres/src/postgres-table-adapter.ts`. Proven by
`packages/adapter-postgres/test/table-at-scale.test.ts` (25,000 rows, a
fast-check property against `matchesFilter` and `applySort`) and
`packages/adapter-postgres/test/postgres-table-adapter.test.ts`. Supersedes the
read-everything behaviour ADR-0107 shipped with.

## Context

The table adapter that serves an existing database (ADR-0107) read the whole
table for every query and filtered in JavaScript. Past `maxRows` (10,000, and
undocumented) every list, query and relationship answered 503, so an ordinary
customer or order table could not be served. Below the cap, every request read
up to 10,001 rows. Id reads compared `rtrim(id::text)`, which no index serves,
so each `getObject` was a sequential scan. The 2026-11-04 pressure test rated
this High (H1).

## Decision

- **A filter becomes a SQL predicate that only narrows.** `columnPredicate`
  compiles a filter to SQL that every row `matchesFilter` keeps satisfies. Each
  row read is still decided by `matchesFilter`, so SQL can never widen or change
  an answer. It only reads less. Which conditions narrow:
  - `eq` and `in` narrow per column kind: text, char(n), integers (in integer
    arithmetic, within int8), numeric (against the exact decimal of the
    neighbouring doubles), booleans and uuids.
  - `gt`, `gte`, `lt` and `lte` on numbers narrow the same way.
  - `ne`, `contains` and `icontains` are left to the re-check. SQL's notions of
    these differ from JavaScript's.
  - A condition on a property the source does not map is `FALSE`, except `ne`.
- **A sort becomes `ORDER BY` when SQL can order as `applySort` does.**
  - Text compares in code-point order (`COLLATE "C"`).
  - Missing values sort last ascending and first descending.
  - The id breaks ties.
  - A key SQL cannot order the same way falls back to reading the matches and
    sorting them in JavaScript, still bounded by `maxRows`: a float, JSON or
    mapped column, or a bigint read as a number.
- **Pages are read in batches.** The adapter reads in batches that grow fourfold
  up to 5,000 rows. It stops at the page's limit plus one match. The cursor is
  the SQL row offset after the last match returned.
- **Ids and foreign keys use their indexes.**
  - An id or a foreign key is compared in the column's own type (`= $1::int8`,
    `= $1::uuid`, `= $1::bpchar`), so the index serves it.
  - A value that cannot be one, such as `02` for an integer key, finds nothing.
  - Only char(n) values lose their padding when read. Text is returned as stored.
- **`maxRows` (default 100,000) now means the most rows one call may read.** It
  no longer limits the size of a table.
- **Aggregation works over these sources.** `aggregate` scans with the same
  predicate and calls `computeAggregations`, so it equals aggregating the
  query's rows. Where a source cannot aggregate, the HTTP API answers
  `422 not-supported` instead of a bare 500 (M4).
- **An unsafe bigint is omitted, not rounded.** An `int8` mapped as an integer
  whose value is not a safe JavaScript integer is left out of the object.

## Consequences

A table of any size is served, and a page costs what the page reads. A filter
that SQL cannot narrow (`icontains` on its own) still reads every row it must
check, up to `maxRows`, and then answers 503 asking the caller to narrow it.
