# 0107. A Database Table Is Declared as Data

## Status

Accepted (2026-11-03). Implemented in `packages/host/src/deployment.ts`
(`PostgresSourceSpec`) and `packages/host/src/host.ts`
(`postgresAdapterForSource`), over `@typesys/adapter-postgres`'s
`PostgresTableAdapter`. Proven by `packages/host/test/durable.test.ts`.

## Context

A deployment could declare an HTTP source as data (ADR-0102), but a
Postgres table, the most common legacy source, needed an extension: code in
the image for what is a table, an id column and a column per property.

## Decision

A `postgres` source names its system, a `$secret` connection string, and per
Type a table, an id column and its columns (a name, or `{ column, as, map }`).
Identifiers are checked as identifiers when the deployment is read and again
when the adapter is built. The adapter reads only: it implements no Action,
so a deployment never writes another system's tables this way. Its pool is
the host's, shared with any state on the same URL, and closed with it.

## Consequences

A legacy parts table is read, governed (a field kept from a role by a
property policy), with no code in the image. Writing to such a table, or
mapping a join or a view the adapter cannot express, still needs an
extension.
