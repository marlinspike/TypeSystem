# 0042. Audit Rows Name the Operation

## Status

Accepted — implemented in `@typesys/core` (`AuditEvent.operation`,
`RuntimeOperation`, and the request context `withRequest` sets in
`runtime/runtime.ts`) and `@typesys/registry-store-postgres` (migration
`0002_audit_operation.sql`, the insert and the row mapping). Proven by:

- `packages/core/test/audit-operation.test.ts` — all eight operations run,
  and every row each writes names it, including decisions made inside
  another call (a relationship's target, a query's include) and an Action's
  outcome row; a `listActions` preview's deny told apart from the
  invocation's.
- The registry-store contract suite, for both stores (Postgres against a
  local PostgreSQL 17 with the migration applied): the operation and details
  round-trip, and a row without one reads back without one.

Mutation-checked (5 mutations): a nested call replacing the outer
operation, `audit()` dropping it, the Action outcome row omitting it, and
the Postgres store failing to write or to read it — each fails the suites.

## Context

An audit row records a decision: who, what action (`read` or `invoke`),
which resource, allow or deny, and — for classification and plans — the
control's details. It does not record the runtime operation that made the
decision. So `listActions` previewing whether an Action is allowed writes
the same rows as `invokeAction` gating it, a denied object inside a `query`
looks like a denied `getObject`, and `explainQuery` looks like a read.
ADR-0032 recorded this, and `PRODUCTION-READINESS.md` item 13 warns whoever
builds alerting on "invoke denials" that previews will trip it.

The operation is known at the one place every call enters the runtime.
Nested reads — a relationship's targets, an include tree, a computed
property — run inside that call.

## Decision

**1. `AuditEvent.operation`.** Every row the runtime writes names the
public operation it was written under: `getObject`, `getRelationship`,
`getProvenance`, `query`, `aggregate`, `explainQuery`, `listActions`, or
`invokeAction`. It is the *outermost* call — a denied related object during
a `query` include records `query` — because that is what the caller asked
for and what an operator alerts on.

**2. Set once, at the entry point.** The runtime carries the operation in
an `AsyncLocalStorage` beside the request's concurrency budget; a nested
call finds it already set and keeps it. `audit()` reads it; a row written
outside any operation is a bug, and a tripwire test runs every operation and
requires every row to name one.

**3. Persisted.** `InMemoryRegistryStore` keeps it as it keeps every field;
`PostgresRegistryStore` gains a nullable `operation` column (migration
`0002`), so rows written before it read back without one. The
registry-store contract suite round-trips it.

## Consequences

- A preview is told apart from an invocation, and a query's per-object
  decisions from a direct read, by one field.
- `AuditEvent` consumers see a new optional field; nothing is published.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **The operation is the runtime's, not the transport's.** An MCP tool call
  and a demo HTTP request both appear as `query`; which front door was used
  is the transport's to log.

## Alternatives Considered

- **Put it in `details`.** No migration, but `details` belongs to the
  control that decided (classification, plans); an operation applies to
  every row and deserves a column an operator can index.
- **Record the innermost call.** A denied include target would read as a
  `getObject` nobody made.
- **Pass the operation down every call chain.** Every private helper would
  grow a parameter to carry what one async-local value already holds.
