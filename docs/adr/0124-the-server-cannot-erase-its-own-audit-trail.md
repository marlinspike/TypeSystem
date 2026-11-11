# 0124. The Server Cannot Erase Its Own Audit Trail, and Shared Deployments Are Not Open

## Status

Accepted (2026-11-11). Covers the remaining findings of the 2026-11-04 pressure
test (H2, M2, M5 to M8, L1, L3 to L6, L8). Implemented in:

- the audit witness: `packages/core/src/audit/chain.ts` and `packages/host/src/audit-cli.ts`;
- the server's role: `packages/host/src/migrate.ts` and `packages/host/src/state.ts`;
- packaging: `packages/host/src/package.ts` and `packages/host/src/promote.ts`;
- deploy test's role map check: `packages/host/src/tests.ts`;
- sign-in: `packages/http/src/sign-in.ts`, `packages/core/src/runtime/runtime.ts` and
  `packages/auth-oidc/src/oidc-identity-resolver.ts`;
- init: `packages/onboard/src/init.ts`, `packages/onboard/src/deployment.ts` and
  `packages/onboard/src/sources.ts`.

Proven by:

- `packages/host/test/audit-owner.test.ts`;
- `packages/host/test/package.test.ts`, `packages/host/test/promote.test.ts`,
  `packages/host/test/usability.test.ts` and `packages/host/test/sign-in.test.ts`;
- `packages/core/test/sign-in-audit.test.ts`;
- `packages/onboard/test/init.test.ts`.

## Context

The hash chain (ADR-0105) catches a row edited, removed or cut off behind a
checkpoint. Two things undid that in practice:

- **The server owned its tables.** It signed in to its state database as the
  role that owned the audit tables, so anyone holding its credential could
  disable the append-only triggers.
- **Nothing outside the database remembered a chain.** Checkpoints lived beside
  the rows, so a chain deleted whole, checkpoints and all, verified as
  `OK: 0 rows in 0 chains`.

The packaged verifier also mounted the signing private key, which verify does
not need.

Around this, the pressure test found more:

- Every deployment was served with discovery `open`.
- `deploy promote` drafted a role map that dropped roles personas combine.
- A refused token left no audit row.
- Tokens with no `exp` or no `sub` were accepted.
- The packaged output published plain HTTP on every interface.
- `init` left out tables, and read bigint and money columns, without saying so.
- `init` gave credentials to the same steward who reads names and emails.

## Decision

### The audit trail

- **A witness kept outside the database.** `typesys audit verify --witness
  <file>` records each chain's newest valid checkpoint and its last row when
  the trail verifies. The next run reports `vanished` when one is gone or
  different. Checkpoints are never deleted, not even by a prune, and a prune
  keeps each chain's last row, so nothing legitimate removes what a witness
  holds. A failed run leaves the witness as it was.
- **The packaged verifier keeps its witness in a volume of its own**, and is
  given no private key: verifying needs only `verifyKeys`.
- **The server's role does not own its state.** `state.audit.ownerUrl` and
  `state.workflows.ownerUrl` name the owner, for `typesys migrate` and
  `typesys audit prune` only. When it is set:
  - Migrate runs as the owner. It creates the server's role, from the `url`
    connection string, if that role does not exist.
  - It grants that role SELECT and INSERT on the audit tables, and SELECT,
    INSERT and UPDATE on the journal's run index, and nothing else. No DELETE,
    no TRUNCATE, and, not owning the tables, no way to lift a trigger.
  - Migrate refuses a server role that is the owner, a member of the owner, or
    a superuser.
  - The server then checks for the journal's tables instead of migrating them.
- **The server warns at start** when its role owns the audit tables or is a
  superuser, outside a demo.
- **Promote writes `ownerUrl`** (`TYPESYS_STATE_OWNER_URL`).
- **Packaging gives the owner's credentials to no one else.**
  - Compose keeps them in `owner.env`, read only by the bundled database,
    `migrate` and `audit-prune`. For a bundled database, the owner's password
    is generated there once.
  - Kubernetes keeps them in a Secret mounted only by the migrate init
    container and the prune CronJob.

### Who may learn the model

- **`runtime.discovery`** (`open`, `authenticated` or `need-to-know`) and
  `securityProfile: "high-assurance-v2"` can be set in a deployment.
- **Promote sets `authenticated`.** An anonymous caller learns nothing of the
  model, and a refusal names no roles.

### Roles

- **Promote's role map grants what every persona holding a role also holds.** A
  steward persona with `[reader, steward]` makes the steward group grant both.
- **`deploy test` fails a tested persona that no one group can make.** A
  persona whose roles no single role-map entry grants would be tested with more
  than any member of one group holds.

### Sign-in

- **A refused bearer token is an audit row.** It is written under
  `unauthenticated` (`action: "sign-in"`), with the verifier's reason and what
  the token claimed, kept as claims.
- **Rows are capped per process.** At most 60 are written a minute. The next
  row counts those left out.
- **A request with no token is not recorded.** Every client makes one to learn
  where to sign in.
- **Tokens need `exp` and `sub`.**

### TLS

- **Compose binds the server to 127.0.0.1 by default** (`TYPESYS_BIND`).
- **`deploy package --target k8s --host <name>` writes an Ingress with TLS.**
- **Both packaged READMEs say how to put the server behind TLS.** Packaging
  warns when `identity.resource` is a non-local `http://` origin.

### Onboarding

`init` says which tables it left out for having no key. It notes each bigint
(read as a number, values past 2^53 left out) and each type it reads as text
(money, with its currency symbol). Credential columns are guarded by a rule
whose role (`credential-reader`) no drafted persona holds, and the drafted tests
say so.

### Smaller fixes

- `typesys --help` lists `deploy promote`, `deploy package` and `audit keygen`.
- The showcase launch test skips on a checkout that has not built its
  applications.
- Redis's `dump.rdb` is no longer tracked.

## Consequences

Erasing a chain now needs both the database's owner credential and write
access to wherever the witness is kept. The witness is only as independent as
that place. A deployment that wants more copies the witness elsewhere after
each run.

A deployment that names no owner works as before and is told, at start and
when packaged, what it gives up.

`/version` still names the packs and build with no token. They are not secret,
and a rollout check reads them.
