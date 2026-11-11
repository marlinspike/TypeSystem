# Hardening pressure test, 2026-11-11

This closes the end-to-end pressure test of 2026-11-04 (2 High, 8 Medium, 8
Low). Each finding below says what changed and how the fix was checked. The
fixes were then pressure tested end to end on a fresh database, `pt`, with a
`shop` schema of 2,000 customers, 200,000 orders and an `events` table with no
primary key: `typesys init --from postgres`, `typesys dev`, `deploy promote`,
`migrate`, `deploy test`, the shared server with a local OpenID Connect
provider, `audit verify` with and without a witness, and `deploy package` for
Compose (checked with `docker compose --profile ops config`) and Kubernetes.

## High

**H1. A Postgres table source could not serve an ordinary table.** Fixed
(ADR-0122). Conditions on plain columns, sorting, paging, counts, relationship
lookups and aggregation now run in SQL (`packages/adapter-postgres/src/table-sql.ts`).
Only a query that cannot be pushed down falls back to a scan, which `maxRows`
(now 100,000, documented) bounds with a message that says what to narrow.
Measured on 200,000 orders: first 5 in 25 ms, `status = open` 7 ms, sorted by
total 26 ms, one by id 5 ms, a customer's related orders 88 ms, a filtered sum
0.32 s; an unfiltered sum is refused with `503` and the message. A property
test (`table-at-scale.test.ts`) checks SQL answers against in-memory answers
for random conditions, sorts and pages.

**H2. Deleting a whole audit chain verified as OK.** Fixed (ADR-0124) in two
parts. The server now signs in as a role that may only SELECT and INSERT its
state; `typesys migrate` signs in as the owner (`state.audit.ownerUrl`),
creates that role and grants it, and refuses one role for both, a superuser
server role, or one that owns or is a member of the owner. Checked as that
role: DISABLE TRIGGER, DELETE, TRUNCATE, UPDATE, the prune flag,
`session_replication_role` and DROP are all refused by Postgres. For what an
owner can still do, `typesys audit verify --witness <file>` keeps each chain's
newest checkpoint and head outside the database; after deleting a chain whole,
plain verify said `OK: 19 rows in 1 chain verify.` and verify with the witness
said `[vanished] chain c3fd... row 19 ...` and exited 1, and kept failing on
later runs. A server whose role owns its tables starts with a warning.

## Medium

**M1. Hosted applications refused real host names.** Fixed (ADR-0123): the
application server gets the deployment's `allowedHosts`, with a test in
`packages/app/test/server.test.ts` that runs in `npm test`.

**M2. Discovery could not be set.** Fixed: `runtime.discovery` is part of the
deployment format, `high-assurance-v2` is accepted and requires
`need-to-know`, and `deploy promote` sets `authenticated`. Checked: anonymous
`GET /api/model` is `401`, and refusals no longer name roles.

**M3. One source going down took the server out of rotation.** Fixed
(ADR-0123): `/readyz` answers for the state stores only and no longer returns
the database's error text; a source that is down answers `503` for its own
Types.

**M4. Aggregation over a Postgres source was a bare 500.** Fixed: the table
adapter aggregates in SQL, and `AggregationNotSupportedError` maps to
`422 not-supported` in the API and its OpenAPI document.

**M5. Packaging undid the audit key separation.** Fixed: the verify service
and CronJob hold no secret (verify needs only `verifyKeys`); the owner's
credentials are in `owner.env`, read only by the database, `migrate` and
`prune`; the server gets `STATE_APP_PASSWORD` for its own role. The Compose
copy of the signing key stays 0644 because Compose bind-mounts the file into a
container that runs as uid 1000; it sits in a `secrets/` directory that is
0700, so no other user on the host can reach it.

**M6. `deploy promote` dropped combined roles.** Fixed: each role maps to
every role held with it by all personas holding it (a steward is also a
reader), and `deploy test` fails a persona that no single role-map entry
covers.

**M7. Failed sign-ins were not audited.** Fixed: an invalid token on the API
or MCP leaves a denied audit row with operation `signIn`, the reason and the
claimed issuer, audience and subject (clipped to 200 characters), at most 60 a
minute with a `notRecorded` count on the next row. A missing token is not
recorded; it is how every MCP client starts.

**M8. No TLS in the packages.** Fixed: Compose binds to 127.0.0.1 unless
`TYPESYS_BIND` says otherwise, Kubernetes with `--host` writes an Ingress that
serves TLS from `<name>-tls`, both packaged READMEs say how to put TLS in
front, and `deploy package` warns when `identity.resource` is plain http on a
real host.

## Low

**L1.** Fixed: tokens need `exp` and a non-empty `sub`.
**L2.** Fixed for `/readyz`. `/version` still returns packs and build id; none
of it is secret and operators use it.
**L3.** Fixed: `init` lists what it left out (a table with no key, and why).
**L4.** Fixed: a non-key `bigint` and an unknown type such as `money` are
listed under "Read with a caveat" with what to do; a bigint beyond ±2^53 is
left out rather than rounded.
**L5.** Fixed: credential columns get their own role, `credential-reader`,
which no drafted persona holds, and a drafted test checks that a steward
cannot read them.
**L6.** Fixed: the help lists `deploy promote`, `deploy package` and
`audit keygen`.
**L7.** Outside the repository: the claude.ai project description still says
the viewer gets `readinessStatus "PMC"`; it should say it is withheld.
**L8.** Fixed: the showcase launch test skips with a reason when the apps are
not built, and `dump.rdb` is no longer tracked.

## Found while checking the fixes

**N1. An OR filter whose branches folded away sent unused values.** The
property test comparing SQL with the in-memory interpreter found, about one
run in three, a filter like `orderId icontains "0" OR orderId eq 0` (the
second branch cannot be narrowed in SQL, so the OR is TRUE) that PostgreSQL
refused with "could not determine data type of parameter $1": the first
branch's value was bound but no longer used. `columnPredicate` now binds only
the values the final predicate uses, and a fixed test covers three such
filters; it fails without the fix.

**Mutations.** Ten mutations for the new behaviour were added to
`tools/mutation/catalog.json` (witness, server role grants, token claims,
sign-in audit and its cap, role map drafting and checking, discovery default,
SQL sort direction). Run locally with only those selected, all ten are
killed; the first run found that a witnessed head cut from a chain's end was
caught only by the checkpoint check, and a test now pins that message.

## Verification

Lint, typecheck and build are clean, and the full suite passes locally with
Postgres and Redis: 2,018 tests in 266 files, 9 skipped (KMS tests that need
Docker, and suites that need a built application). GitHub CI runs the lean job
only.
