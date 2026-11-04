# 0117. `typesys migrate` Reads the Deployment

## Status

Accepted (2026-11-04). Implemented in `packages/host/src/migrate.ts`,
`packages/registry-store-postgres/src/migrate.ts` (`pendingMigrations`),
`packages/cli/src/bin.ts` and `packages/host/src/serve.ts` (`serve.js
migrate`). Proven by `packages/host/test/migrate.test.ts`.

## Context

The only migration step was `npm run migrate:postgres`: it read
`DATABASE_URL`, not the deployment's `state` and its `$secret` references, ran
from TypeScript sources the image does not ship, and created the airforce
demonstration's tables. `typesys deploy build` passed against a database that
was not migrated, and the server then refused to start.

## Decision

`typesys migrate <deployment.json>` (or `TYPESYS_DEPLOYMENT`) creates and
updates the tables of the state the deployment declares: `state.audit` (the
registry store's migrations, under its advisory lock) and `state.workflows`
(the workflow journal). It reads the document only, so it needs no packs, and
resolves connection strings as the server does, including `<NAME>_FILE`. The
image runs it as `node packages/host/dist/serve.js migrate`. `typesys deploy
build` reports pending migrations by name and says to run it; a database it
cannot reach is reported with its connection string redacted.

## Consequences

One command, run before the replicas start, takes a database from empty to
ready; Compose and Kubernetes run it as a one-shot step or init container.
Migrations stay forward-only.
