# Pressure test of TypeSystem 3.0 (PR #14)

Reviewed: PR #14, branch `claude/typesystem-3-hardening-3mkmfl` at `1df78c9`
(M1 through M6 and the rewritten README). Date: 2026-10-14. Independent of
the thread that wrote the code; no product code was changed.

Reproductions are on branch `claude/pressure-test-3-0-bseuc8` as `p3-*.test.ts`
files. Each test asserts what the ADR, the README or the code's own comments
promise, and fails on `1df78c9` for the stated reason. Tests marked as
controls pass and record attacks that held.

```
npm ci && npm run build && npx vitest run                  → 1,206 pass, 79 skipped
DATABASE_URL=… REDIS_URL=… npx vitest run (Postgres 16)     → 1,280 pass, 5 skipped
npx vitest run packages/*/test/p3-*.test.ts (with DB)       → 39 fail, 5 pass
```

The mutation suite (ADR-0070) and the evaluation harness (ADR-0073) are still
being re-run; their findings will be added to this report as an addendum.

## Summary

**34 findings: 3 High, 14 Medium, 17 Low.** All 27 M2 and 17 M4 findings still
hold for their own reproductions (the 77 `m2-adv`/`m4-adv` tests pass). Several
were fixed at one entry point while a sibling entry point keeps the same flaw:
`explainQuery` next to `describeModel` and `previewAction` (H4), the preview
next to the invoke (M7, M8), the run status route next to the outputs route
(H1), and `host.module` next to the other MCP-root paths (M1, L5).

The two most serious new problems are in code no review had touched before.
`explainQuery` ignores the discovery mode completely, so under `need-to-know` an
anonymous caller gets a plan naming data sources, policies and withheld
members over REST, MCP, the SDK and Studio. The new HTTP adapter follows
redirects with its credentials attached, so a service (or an open redirect on
it) can send TypeSystem's API key or OAuth client secret to any host.

The README's Postgres example and the three-caller Aircraft read reproduce
exactly. Seven README statements are wrong or overstated (section R).

| # | Sev | Finding | Test |
|---|---|---|---|
| P3-D1 | High | `explainQuery` ignores discovery mode: anonymous callers and withheld Types/members get full plans (core, REST, MCP) | core/http/mcp-server `p3-discovery` D1, D2, D3, D5, D7 |
| P3-H1 | High | HTTP adapter follows cross-origin redirects with its header key; a token endpoint's 307 re-posts the client secret | adapter-http `p3-http` H1, H1b |
| P3-H10 | High | Under a call deadline, a computation's `queryByType(type, filter)` gets `{signal}` as `limit` and returns nothing | adapter-http `p3-runtime` H10 |
| P3-RL1 | Medium | `previewAction` tells a model-bound caller the unmasked policy reason (reopens M8) | domain-airforce `p3-release` RL1 |
| P3-RL2 | Medium | `GET /api/workflow-runs/:id` shows a model the run's control flow, which encodes data it is refused | http `p3-discovery` RL2 |
| P3-D6 | Medium | Preview blockers carry the policy's reason when discovery is not `open` (defeats M7) | http `p3-discovery` D6 |
| P3-J1 | Medium | On Postgres, a run whose finish reason holds a NUL (or the text `\u0000`) can never finish | workflow-postgres `p3-journal` J1, J1b |
| P3-I1 | Medium | A source's 403 leaks object existence to an anonymous caller (contradicts ADR-0048) | sortie-readiness `p3-interop` I1 |
| P3-I2 | Medium | Refusals count toward the circuit breaker: one caller's refused reads take the source down for all | sortie-readiness `p3-interop` I2 |
| P3-I3 | Medium | A nested required include's failure is swallowed and blamed on its optional parent's healthy source | core `p3-optional` I3 |
| P3-H2 | Medium | A token endpoint answering 200 non-JSON throws a bare `SyntaxError` (500, fails optional includes) | adapter-http `p3-http` H2 |
| P3-H4 | Medium | Silent truncation: a numeric `next` cursor, or `next` without `cursorParam`, ends the list after page one | adapter-http `p3-http` H4, H4b |
| P3-H9 | Medium | A list over `maxPages` is a retryable outage: re-read 3× and counted toward the breaker | adapter-http `p3-http` H9 |
| P3-E2 | Medium | Engineer `query … atMost` decided on the first page only; an empty page with a cursor passes | engineer `p3-engineer` E2 |
| P3-A1 | Medium | `TRUNCATE audit_events` succeeds with the runtime's credential (journal got this fix in M2 L1, audit did not) | registry-store-postgres `p3-audit-integrity` A1 |
| P3-R1 | Medium | `getProvenance(needsAttention)` omits the maintenance system when a work order decides the value | domain-airforce `p3-readme-provenance` R1 |
| P3-R2 | Medium | README says TypeSystem keeps no copy of business data; the Redis cache and workflow journal both hold it | none (code reading) |
| P3-D4 | Low | A described property's `$ref` or an Action's `outputSchema` can name a withheld Type | core `p3-discovery` D4 |
| P3-D9 | Low | `listActions` names an Action `describeModel` withholds | core `p3-discovery` D9 |
| P3-D8 | Low | MCP passes `examples` through unnarrowed, naming withheld members | mcp-server `p3-discovery` D8 |
| P3-J2 | Low | Postgres journal refuses a lone UTF-16 surrogate after the effect happened (gap left by L3) | workflow-postgres `p3-journal` J2 |
| P3-W1 | Low | An approver's expired credentials are not checked by `approve`/`pendingApproval` | workflow `p3-authority` W1, W1b |
| P3-RL3 | Low | Workflow refusals to an audience-bound caller are unmasked (contradicts ADR-0067 amendment) | workflow `p3-release` RL3 |
| P3-H3 | Low | Token endpoint 403 reported as retryable "unavailable", not `SourceRefusedError` | adapter-http `p3-http` H3 |
| P3-H5 | Low | Object id `..` or `.` reaches another endpoint with TypeSystem's credential | adapter-http `p3-http` H5 |
| P3-H6 | Low | Credentials in `baseUrl` userinfo appear verbatim in errors and problem details | adapter-http `p3-http` H6 |
| P3-H7 | Low | Concurrent reads each fetch their own OAuth token (5 reads, 5 tokens) | adapter-http `p3-http` H7 |
| P3-H8 | Low | Provenance names the escaped pointer token (`mc~1status`), not the field | adapter-http `p3-http` H8 |
| P3-E1 | Low | `host.module` confinement is lexical: a symlink or `pkg/../../` escapes and runs during plan | engineer `p3-engineer` E1, E1b |
| P3-E3 | Low | `starts … failed` passes whichever step failed | engineer `p3-engineer` E3 |
| P3-E4 | Low | `typesys_engineer_plan` on sortie-readiness leaks three service processes per call | engineer `p3-engineer` E4 |
| P3-R3 | Low | The relationship query `values ->> $2 = $3` cannot use the GIN index the migration says it serves | none (EXPLAIN below) |
| P3-R4 | Low | README read path order is wrong: every computed property runs before redaction, visible or not | none (code reading) |
| P3-R5 | Low | README doc drift: Aircraft snippet omits `releases`; Truck example exits before `listen`; completeness.md says 1,053 tests | none |

## High

### P3-D1. `explainQuery` ignores the discovery mode (ADR-0068)

`packages/core/src/runtime/runtime.ts:1671` never checks `discovery` or
whether the caller is anonymous, and does not refuse a plan over a withheld
Type. `describeExecution` then names the object policy (`:1804`), every
computed value and its inputs (`:1805`), and every policy-gated or marked
member (`:1808`). Under `need-to-know`, an anonymous caller is refused
`describeModel` but `POST /api/query/explain` and `typesys_explain_query`
answer 200 with data source ids and policy names. The viewer's plan for
`airforce.Aircraft` names `deploymentLocation`, `maintenanceStatus` and
`readinessStatus`. A withheld Type returns its plan and policy name instead of
"Unknown type". This is the class of M2's H4, through a route it did not cover.

### P3-H1. Credentials follow redirects to other origins (ADR-0072)

`packages/adapter-http/src/http-adapter.ts:135-137` calls `fetch` with the
default `redirect: "follow"`; credentials are added at `:120-123`. On a
cross-origin redirect undici strips only `Authorization`, so a custom key
header (the depot's `x-depot-key`) reaches the new host, and a 307/308 from the
token endpoint re-posts `client_secret=…`. Both tests stand up two real local
servers and observe the second one receive the secret. Fix: `redirect:
"manual"` or `"error"`, or same-origin only.

### P3-H10. A deadline turns a computation's query into an empty result (ADR-0026)

`runtime.ts:608-612` (and `read-coalescer.ts:122,149`) appends `{signal}` at
`args.length`. A computed property calling `ctx.getAdapter(ds).queryByType(type,
filter)` with two arguments passes the signal as `limit`; `HttpAdapter`
computes `slice(0, "0[object Object]")` and returns no items. In the test the
count is 2 without `callTimeoutMs` and 0 with it. Any computation that omits
trailing arguments silently gets wrong answers once a deadline is configured,
and the shipped `computeNeedsAttention` calls `queryByType` exactly this way.
Graded High because it silently changes computed values with a
production-recommended setting.

## Medium

**P3-RL1.** `runtime.ts:2258` pushes `gate.decision.reason` unmasked into the
preview's authorization blocker; `invokeAction` masks it through
`notAuthorized` (`:329`). An agent bound to the enclave model previewing
`UpdateWorkOrderStatus` is told "Not releasable to model…" on its user's own
work order and "Requires one of roles [lead]…" on another's, so it learns which
work orders are its user's: the oracle M8 closed for reads.

**P3-RL2.** `packages/workflow/src/engine.ts:451-459`: `status()` admits the
initiator's subject under any audience; only `outputs()` (`:470`) got H1's
check. A commercial-model agent refused the Aircraft and the outputs still
sees one GroundForRepair run `waiting-approval` and another `completed` with
every step after `flagged` skipped, which says which aircraft needs attention.

**P3-D6.** Same line as RL1. M7's fix masks reasons only on the error path
(`packages/http/src/problems.ts:71`); a preview is a 200, so under
`need-to-know` the preview body carries "Requires one of roles [lead], subject
has [maintainer]; Requires resource.assignedTo to match subject.displayName".

**P3-J1.** `packages/workflow-postgres/migrations/0002_journal_integrity.sql:33`
recognises a finish by `event->>'type' = 'run-finished'`, while
`postgres-journal.ts:37` wraps any event whose JSON contains `\u0000` as
`{"$typesys-json": …}`, which has no `type`. A cancel reason `"abort\u0000now"`,
or text merely spelling the escape, makes the `run-finished` append fail; the
run stays `compensating` forever and the triggers forbid repair. The
in-memory journal finishes the same run.

**P3-I1.** `runtime.ts:1187-1192`: `authorizeRead` reads the source before
deciding the policy, and a service 403 becomes `SourceRefusedError`
(`http-adapter.ts:151`, HTTP 502). An anonymous caller gets 502 for a KVPS
requisition that exists and 403 for one that doesn't. ADR-0048 says the
decision comes first so a denied caller learns nothing about existence.

**P3-I2.** `packages/core/src/runtime/resilience.ts:208-209` records a failure
for every error, including `SourceRefusedError`. With `failureThreshold: 2`, a
planner's two refused KVPS reads open the depot's circuit and every caller's
KHIF reads fail with `CircuitOpenError`, although the depot answered both
times.

**P3-I3.** `runtime.ts:1925-1931`: `attachIncludes` catches any error in the
include subtree and attributes it to the outer relationship. With an optional
`Ship.sailors` (source `crew`) holding a required `Sailor.kit` (source `kit`),
a `kit` outage returns success with `unavailable: [{path:"sailors",
dataSourceId:"crew"…}]`. ADR-0072 says a required relationship still fails.

**P3-H2.** `http-adapter.ts:126` calls `res.json()` unguarded on the token
response (unlike `get()` at `:153-157`). A proxy login page answering 200 HTML
throws `SyntaxError`, a 500 "internal" that also fails optional includes,
where ADR-0072 maps non-JSON to `AdapterUnavailableError`.

**P3-H4.** `http-adapter.ts:210` treats `typeof next !== "string" ||
!m.list.cursorParam` as end of list. A numeric `next: 2` drops page two; a
mapping with `next` but no `cursorParam` passes construction and stops after
page one. ADR-0072: "never answered from a truncated read".

**P3-H9.** `http-adapter.ts:198` throws `AdapterUnavailableError` (retryable)
for a list over `maxPages`. With `RECOMMENDED_RESILIENCE_POLICY` the runtime
re-reads up to 20 pages three times and counts each toward the breaker, so a
few broad queries from one caller can open it for everyone.

**P3-E2.** `packages/engineer/src/verify.ts:113-121` never reads `nextCursor`.
The runtime drops denied items page by page (`runtime.ts:1562-1564`), so a page
can be `{items: [], nextCursor}` with readable rows later, and `atMost: 0`
passes: M4's H1/M4 in a new place.

**P3-A1.** The `audit_events` triggers are row-level `BEFORE UPDATE`/`BEFORE
DELETE`. `TRUNCATE audit_events` with the runtime's own credential (it owns the
table) empties the log. ADR-0015 says no "compromised credential short of
superuser" can delete an audit row. The workflow journal received a `BEFORE
TRUNCATE` trigger in M2 (L1); the audit log did not. The fix also needs the
Postgres test helper (`truncateAll`) to stop truncating `audit_events`, and
ideally the table owned by a role the runtime does not log in as, since an
owner can `DISABLE TRIGGER`.

**P3-R1.** The README says `getProvenance` "traces it back to the values it
was derived from". With AF86-0147 set `operational` and an open work order
created through `CreateMaintenanceWorkOrder`, `needsAttention` is `true` but
the trace is only `maintenanceStatus = operational` from `airforce-repo`: a
value that by the computation's own rule cannot produce `true`. The maintenance
system is never named. Graded Medium because traceable provenance is the
product's headline claim.

**P3-R2.** The README says TypeSystem "does not copy your data into a store of
its own… The only data it owns is its own metadata". `packages/redis/src/redis-cache.ts:18,50`
stores adapter output and computed values as plaintext JSON, and the workflow
journal stores step outputs. A reader deciding data residency or
accreditation from the README would miss both.

## Low

**P3-D4** (`discovery.ts:108`, `:89`): a readable property `{$ref: …/Compartment}`
or an Action `outputSchema` naming a withheld Type reaches the viewer through
`/api/model`, OpenAPI and MCP. **P3-D9** (`runtime.ts:2208-2214`): `listActions`
decides on `typeName` alone and lists an Action targeting a withheld Type.
**P3-D8** (`packages/mcp-server/src/reads.ts:19`): `examples` is allowlisted
and passed through unnarrowed. **P3-J2** (`postgres-journal.ts:35-38`): only NUL
is encoded; JSONB refuses `\ud800`, so a `step-completed` append fails after the
effect. **P3-W1** (`engine.ts:203-215`, `:232-236`): `approve` and
`presentApproval` never call `expiry()`, while `cancel` and `reauthorize` do.
**P3-RL3** (`engine.ts:184`): workflow refusals to an audience-bound caller
carry the raw reason. **P3-H3** (`http-adapter.ts:124-125`): only 400/401 from
the token endpoint count as refusals. **P3-H5** (`:180`, `:146`): ids `..`, `.`
and `%2E%2E` are normalised by `new URL` into other endpoints; the record-id
check limits the damage. **P3-H6** (`:140`): userinfo in `baseUrl` lands in
error messages. **P3-H7** (`:121-131`): no single-flight on token fetch.
**P3-H8** (`:173`): provenance uses the escaped token; `/a.b` and `/a/b`
collide. **P3-E1** (`packages/engineer/src/host.ts:239-242`): no realpath, and
package-relative specifiers bypass `isPath`. **P3-E3** (`verify.ts:143-151`):
only `status` is compared. **P3-E4** (`mcp.ts:98`, `plan.ts`,
`packages/sortie-readiness/src/setup.ts:139`): the plan's host is never torn
down, contradicting `mcp.ts`'s own comment.

**P3-R3.** The migration comment on `idx_objects_values` says the GIN index
serves the `byForeignKey` pushdown. GIN `jsonb_ops` supports `@>`, not `->>`
equality. With 200,000 rows and `enable_seqscan = off`:

```
values ->> 'fk' = 'p7'      → Bitmap Index Scan on objects_pkey (every row of the Type), Filter on ->>
values @> '{"fk":"p7"}'     → Bitmap Index Scan on idx_objects_values
```

Every relationship traversal reads every row of the target Type. Filters use
`@>` and do hit the index, as the README says.

**P3-R4.** README step 4 then 5 says properties are removed and then "computed
properties the caller may see" run. `finalizeValues` runs every computed
property first (including cross-source reads for values the caller will never
see), then classification, then policies. The result is the same; the cost and
the documented order are not.

**P3-R5.** (a) The README's Aircraft snippet omits `releases:
["maintenanceStatus"]` on `needsAttention`, yet the text below relies on it;
copied as shown, the viewer would not see `needsAttention`. (b) The Truck
example, run as written, throws at the dispatcher's `SetTruckStatus` (the
README marks it `// throws`) and exits before `createApiApp(...).listen`, so the
curl paragraph cannot be reproduced without wrapping that call. (c)
`docs/completeness.md:469` still says 1,053 tests.

## README claims verified

Run against PostgreSQL 16 and the built tree:

- The fleet.Truck example (with the refused call wrapped in `try`): the
  dispatcher reads without `driverNotes`; the mechanic's `SetTruckStatus`
  succeeds; the dispatcher's is refused with `AuthorizationError: Not
  authorized: invoke fleet.Truck/SetTruckStatus`; `objects` holds one row with
  `out-of-service`; `audit_events` holds the read, allowed and success rows,
  the refusal, and per-property deny rows for `driverNotes`. curl with
  `mo-token` returns `driverNotes`, with `dana-token` not, anonymous gets 403.
  Re-running the script against the same database also works.
- The three-caller Aircraft read matches the README exactly, as do the
  provenance JSON shape and `getProvenance(needsAttention)` for AF86-0147.
- The `Adapter` interface, the `objects` DDL, the `SELECT values …` load, the
  `@>` equality filter with re-check in `matchesFilter`, the relationship SQL,
  the write path order (policy, input schema, preconditions, adapter, cache
  eviction, audit), the generic adapters implementing no Actions, the
  journal's table names and append-only triggers, the MCP tool names, the REST
  routes, the SDK call, `createOidcIdentityResolver`, the KMS emulator in CI,
  73 ADRs, and ports 4000, 3939 and 4400 (each started and answered).
- `npm run smoke:mcp` passes and `npm run check:terminology` is clean.

## Earlier reviews: fixes verified

- **M2 (27 findings):** all 51 `m2-adv` tests pass, Postgres included. H1, H2,
  H6, M1-M4, L4, L5 re-traced through `keepAudience`, `currentAuthority`,
  `reauthorize` and `cancel`; L1-L3 triggers hold against TRUNCATE, delete and
  forged `finished`; M9 signature binding, M10, M11, L8, L9 hold. Variants that
  broke: P3-D1 (H4), P3-RL1 (M8), P3-D6 (M7), P3-RL2 (H1), P3-J1 (L2×L3).
- **M4 (17 findings):** all 26 `m4-adv`/review-fix tests pass. H2 holds against
  `noEmit`, `outDir`, `rootDir`, `include` edits, a symlinked `dist` and stale
  `dist/client`; H1, H3, H4, M2, M3, L1, L2 hold. Variants that broke: P3-E1
  (M1/L5), P3-E2 (H1/M4).

## Attacks that held

JSON Pointer decoding order and prototype keys; re-checking every
pushed-down filter locally, so a remote returning non-matching rows leaks
nothing; query values built with `URLSearchParams`; repeated cursors bounded;
a 404 list is unavailable, never empty; header-auth 401/403 is a refusal and a
client-credentials 401 renews once; viewers refused filter and sort on
withheld properties; `bindAudience` keeps the host's audience over a forged
one; approvers bound to a model are decided for both principals; Postgres
start/append races.
