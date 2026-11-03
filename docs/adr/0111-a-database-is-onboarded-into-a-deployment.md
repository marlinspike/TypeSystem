# 0111. A Database Is Onboarded Into a Deployment

## Status

Accepted (2026-11-03). Implemented in `packages/onboard/src/init.ts`
(`initCommand`, `typesys init --from postgres`),
`packages/onboard/src/deployment.ts` (`draftDeployment`,
`updateDeployment`, `packRules`) and `packages/onboard/src/command.ts`
(`onboard propose --deployment`). Proven by `packages/onboard/test/init.test.ts`.

## Context

Onboarding (ADR-0076) wrote a pack and an `adapters.json`, and the generic
host serves a declared Postgres table (ADR-0107), but nothing joined them.
Getting one's own table served meant writing the deployment by hand:
copying the pack's digest, retyping each adapter plan as a source in a
different shape, writing every rule the pack names, and adding personas
and tokens. Measured on main, that was about 11 commands and 30
hand-written lines before a first governed read.

## Decision

`typesys init <dir> --from postgres <ENV_VAR> --schema <s>` collects the
catalog, proposes the baseline, records every item the catalog declares as
accepted (by `--by`, default "typesys init"), verifies it, and writes:

- the pack, under `packs/`, listed in the deployment by version, digest and file;
- `<domain>.deployment.json`, a demo deployment whose `postgres` sources are
  the verified mapping, with the connection string referred to by the
  variable named on the command line and never written;
- a draft rule for every rule the pack names, one role per kind: a Type's
  read rule to `reader`, a sensitive property's to `steward`, an Action's
  to `operator`. No rule is `"always"`;
- personas `reader`, `steward` and (when there are Actions) `operator`,
  each with a token random to this draft;
- `<domain>.tests.json`, policy tests (ADR-0113) for what the draft rules
  promise, written as queries so no id or value from the database is in
  them;
- a README naming each file, each persona's token, and what to change
  before anyone else uses it; and the onboarding record under `onboarding/`.

It refuses to overwrite an existing deployment without `--force`.

`typesys onboard propose ... --deployment <file>` keeps such a deployment
current: the new pack's version, digest and file; each Postgres source's
mapping replaced by the verified one, keeping its connection reference; and
a draft rule for each rule the model now names that the deployment lacks.
Rules the deployment already has are never changed; ones the model no
longer names are kept and reported.

## Consequences

A newcomer's own database is a governed, served deployment in three
commands (init, export the variable, dev), and the first read already
shows a field withheld from one persona and returned to another. Accepting
the catalog's declarations without a review step is safe because every
draft rule admits only a role a person must be given, and the
sensitive-data flags protect from the first run. Only PostgreSQL sources
are drafted; an OpenAPI source still needs its base URL and credentials
written by hand.
