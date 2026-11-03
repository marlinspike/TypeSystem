# 0106. A Deployment Declares Where Its State Lives

## Status

Accepted (2026-11-03). Implemented in `packages/host/src/deployment.ts`
(`state`, `runtime.securityProfile`), `packages/host/src/state.ts`
(`openState`) and `packages/host/src/host.ts`. Proven by
`packages/host/test/deployment.test.ts`, `packages/host/test/durable.test.ts`
and `packages/host/test/check.test.ts`.

## Context

ADR-0102 made a deployment one document built by one generic server, but
the document could not say where anything outlived a request. The server
always ran on an in-process registry, so its audit trail was lost on every
restart, and restart is how an upgrade rolls; the reference Kubernetes
manifest ran two replicas with two separate audit logs and two rate budgets,
and passed `DATABASE_URL` and `REDIS_URL` to a server that read neither.

## Decision

A deployment's `state` declares the audit trail (`memory` or `postgres`,
with `signing`, `verifyKeys` and `retainDays`), the workflow journal
(`memory` or `postgres`), the cache (`memory` or `redis`) and the rate
limit (`memory` or `redis`, with capacity and refill). Every URL is a
`$secret` reference. `runtime.securityProfile` names `high-assurance-v1`
(ADR-0046).

The model stays in-process, built from the packs (ADR-0102): only the audit
half of the registry store goes to Postgres (`withAuditLog`), so a replica
booting a new build still never changes what another serves. Everything is
connected before the server listens; an unreachable database or Redis, an
audit table not migrated through 0008, or a signing key that is not Ed25519
is a boot failure. The journal migrates itself, as ADR-0066 allows; the
audit tables never do (ADR-0015).

A deployment that is not a demo must keep its audit trail in Postgres and
sign it. `typesys deploy check` reports state changes and blocks giving up a
kept audit trail, its signing, or a kept journal. The check and
`typesys deploy build` build with `state: "memory"`, so they write nothing
into the deployment's trail or journal.

## Consequences

A restart keeps every row; two replicas write two chains into one table and
both verify; two replicas share one rate budget through Redis. `GET
/version` reports where state is kept and the process's audit chain. The
shipped `airforce-durable` deployment is what `docker compose up` serves.
