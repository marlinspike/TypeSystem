# 0044. Provable Numeric Pushdown

## Status

Accepted — implemented in `@typesys/adapter-postgres` (`src/double.ts`:
`exactDecimal`, `nextUp`, `nextDown`; the numeric cases of `src/sql-filter.ts`).
Proven by `packages/adapter-postgres/test/numeric-bounds.test.ts`: exact
decimal expansions of known doubles, including the smallest subnormal's
1,074 digits; round trips and neighbor relations over 3,000 doubles —
integers, fractions across forty orders of magnitude, subnormals, the
largest and smallest; and, against a local PostgreSQL 17, a boundary
differential over some 190 stored decimals written raw — each double's
exact value, the exact midpoints to its neighbors (ties included), those
midpoints nudged by 10⁻²⁴, `1e400`, `-1e400`, `1e-400`, a 30-digit integer —
where every `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, and `in` against each double
and its neighbors returns exactly what `matchesFilter` returns over
JavaScript's view of the rows (over 500 conditions). The ADR-0040 suite now
asserts no numeric condition is exact and no SQL names `float8`.

Mutation-checked (11 mutations): tightening either bound of `eq`, the lower
bound of `gte`, the upper of `lte`, or the bound of `gt` or `lt` to a
neighbor; `ne` ruling out a neighborhood instead of the exact value; a
numeric condition marked exact; and, in `double.ts`, an off-by-one exponent,
`nextUp` of a negative moving away from zero, and subnormals given an
implicit leading bit — each fails the suites.

## Context

ADR-0040 compiles numeric conditions to SQL that compares
`(values->>p)::float8` with the filter's number, and marks them *exact*. The
argument: parsing the stored decimal to a double is the same IEEE rounding
in Postgres as in `JSON.parse`. That holds only if Postgres's `float8`
input rounds correctly on the platform it runs on — true of modern C
libraries, but an assumption about someone else's code, not something the
adapter can show. Since ADR-0038, "exact" is a security contract: an exact
predicate that drops a row the caller may read hides data, and SQL paging
over an exact filter trusts it completely. A claim the adapter can't prove
is a claim it must not make.

What the adapter *can* prove: JavaScript's view of a stored decimal `x` is
`round(x)`, the nearest double; rounding is monotone; and the exact decimal
value of any double is computable. So for a double `v` and its neighbors
`v⁻ < v < v⁺`:

- `round(x) = v` implies `v⁻ < x < v⁺`;
- `round(x) > v` implies `x > v`, and `round(x) ≥ v` implies `x > v⁻`;
- `round(x) < v` implies `x < v`, and `round(x) ≤ v` implies `x < v⁺`;
- `round(x) ≠ v` can only be ruled out where `x` is exactly `v`.

Each is a comparison of exact decimals, which Postgres `numeric` does
exactly.

## Decision

**1. Numeric conditions compile to supersets bounded in exact arithmetic.**
The adapter computes the exact decimal expansion of `v` and of its
neighbors (from the double's bits, with `BigInt`), binds them as text, and
compares `(values->>p)::numeric` against them by the rules above; a missing
neighbor (beyond the largest double) leaves that side unbounded. Every such
condition is marked a *superset*, never exact.

**2. JavaScript decides, as it already does for supersets.** The adapter
re-checks every row it reads with `matchesFilter` and, for a filter that
isn't exact, pages in JavaScript (ADR-0040), so results, order, and cursors
are exactly `matchesFilter`'s. What the SQL does is narrow, soundly.

**3. The exact list shrinks to what needs no numeric parsing.** Equality on
strings, booleans, and `null` through `@>` stays exact: JSONB compares those
as JavaScript does. A filter with any numeric condition is paged in
JavaScript.

## Consequences

- No exactness claim in the adapter depends on Postgres's floating-point
  input. A stored decimal with more precision than a double, one outside
  its range, or one in the gap between two doubles is handled, and a cast
  can no longer fail on one.
- A numeric filter — including a plan atom on a numeric attribute — reads
  its SQL-narrowed rows and pages them in JavaScript instead of with
  `LIMIT`/`OFFSET`: correct and private, somewhat less efficient.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **The proof rests on JavaScript's number parsing being correctly
  rounded**, which ECMAScript requires, and on `node-pg` handing `jsonb` to
  `JSON.parse`.

## Alternatives Considered

- **Keep `float8`, and test the platform at startup.** A test can't prove
  rounding for every input.
- **Compare as `numeric` against `v` itself.** Excludes rows JavaScript
  keeps — a stored `0.1000…01` is `0.1` to JavaScript and not to `numeric`.
- **Refuse to push numeric conditions at all.** Reads every row of a Type
  for any numeric filter; the bounded superset narrows safely.
