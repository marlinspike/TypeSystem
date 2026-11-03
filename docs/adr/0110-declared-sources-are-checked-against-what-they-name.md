# 0110. Declared Sources Are Checked Against What They Name

## Status

Accepted (2026-11-03). Implemented in `packages/host/src/host.ts`
(`sourceMappingProblems`, `Host.checkSources`), `packages/host/src/cli.ts`
(`deploy build`, `--offline`), `packages/host/src/serve.ts` and
`packages/adapter-postgres/src/postgres-table-adapter.ts` (`checkMapping`,
`readFailure`). Proven by `packages/host/test/sources.test.ts`.

## Context

Trying the newcomer's path on main at e792c16
([ease-of-use assessment](../evidence/ease-of-use-2026-11-03.md)) showed that a
deployment's `postgres` source with a misspelt column (`"tier": "tierz"`)
passed `typesys deploy build`, the server reported ready, and every read of
the Type returned `500 Internal error`. The database's own message, with
its suggestion, was only in the server log. A mapping for a property the
Type does not have was accepted and silently never read.

## Decision

A deployment's own sources are checked in two places.

Against the model, when the host is built: every Type a source maps must be
one a pack registers and the model reads from that source, and every mapped
property must be one the Type has. Each problem names the source, the Type
and the property, with the name probably meant when one is close.

Against the database, by `Host.checkSources()`: every mapped table or view
exists and the connection may read it, and it has the id column and every
property column the mapping names. Only the catalog is read
(`to_regclass`, `pg_attribute`, `has_table_privilege`), never a row.
`typesys deploy build` runs it unless `--offline`; the server runs it at
start and refuses to start on a problem. A database that cannot be reached
is not a mapping problem: `deploy build` fails naming the source, and the
server starts and `/readyz` reports it until it answers.

A read the database cannot answer as mapped is no longer an internal error.
An undefined table or column is a non-retryable `AdapterUnavailableError`
naming the source and the Type (503 `unavailable`), with the database's
message kept in `cause` for the log, not shown to the caller. A permission
refusal is the source's refusal (`SourceRefusedError`, 502
`source-refused`). A socket error is the source being unavailable. The
API's error log now records 5xx problems, not only 500s, so an operator
sees why.

A pack refused for its digest no longer also produces "no pack declares a
data source with this id" for its sources.

## Consequences

The class of mistake most likely in a hand-edited or re-onboarded
deployment is caught before anything serves, with a message that says
what to change. `deploy build` now needs the database reachable unless
`--offline`, which a CI step without database access passes. HTTP sources
are checked against the model only; checking them against a service
would mean calling it.
