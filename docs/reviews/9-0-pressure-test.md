# Mandate 9 pressure test (your database, governed, in five commands)

Reviewed: `claude/project-thread-itvy4r` at 28e5345 (ADR-0110 to ADR-0115),
2026-11-03. An independent reviewer read the change from `e792c16` and tried
to break `typesys init --from postgres`, `typesys dev`, the source checks,
policy tests, accepted widenings, `typesys pack build` and the command shims,
against real PostgreSQL in a scratch database. Each finding was reproduced
with a script against the built packages, or traced to the exact lines.

**Summary: 17 findings. 3 High, 8 Medium, 6 Low.** All three High and all
eight Medium are fixed, each with a test. Five Low are fixed; one (L4) is
kept as a documented limit. Eight new mutations guard the fixes that are
security checks.

The common thread was what a newcomer's first five minutes do on a real
database: the defaults have to be safe, because nobody has read anything
yet. A dev server on every interface, a column the name rules did not
recognize, and a second `init` over someone's review were each defaults a
first-time user would never think to question.

## High

### H1. `typesys dev` served a real database on every interface, with its tokens in the README. Fixed.

`serve` passed no address to `listen`, so `dev` answered on every
interface, while it printed "fixed tokens: this machine only". The drafted
README carried every persona's token, including the steward's. The
DNS-rebinding guard checks only the `Host` header, which a non-browser
client sets as it likes. `serve` now takes a listen address; `typesys dev`
listens on 127.0.0.1 unless `--host` says otherwise, and says "answered on
this machine only" only when that is so. The README no longer carries
tokens: they are in the deployment's `identity.tokens`, and `dev` prints
them. Test: `usability.test.ts` (dev); mutation `dev.every-interface`.

### H2. A drafted deployment gave readers every column the name rules missed. Fixed.

Sensitivity came only from column names, and `init` accepts what
onboarding proposes, so `card_number`, `tax_id`, `birthday`, `surname`,
`emailaddress`, `latitude`, `private_key`, `pwd` and others went to every
reader, and the drafted tests, covering only what was flagged, still
passed. The name rules now recognize compound and abbreviated names
(joined words, card and bank details, tax and national ids, licences,
locations, credentials, user names), checked against a list of names that
must not be flagged (`credit_limit`, `tax_amount`, `status`, `region`).
`init` now prints, per Type, every column a reader is returned and asks for
it to be checked; the README lists the same, with how to withhold one. When
`onboard propose --deployment` maps a new column, it says so and names the
rule guarding it, or that none does.

We did not make every unflagged column steward-only: a drafted reader who
sees only ids is not a usable starting point, and the listing puts the
decision in front of the person at the moment it matters.

### H3. `typesys init` overwrote README.md and the reviewed `onboarding/review.json`. Fixed.

Only the deployment file was checked before writing. `init` now checks
every file it would write, and refuses, naming each, unless `--force` is
given; with `--force` each is kept beside as `<file>.bak`. A README already
in the directory is one of them. Test: `init.test.ts`; mutation
`init.overwrites`.

## Medium

### M1. A `refused` policy test passed when nothing was refused. Fixed.

An empty query result counted as a refusal, so "anyone else is refused" passed on an empty
table under an `"always"` rule. An Action preview counted any blocker, so a
target that did not exist, or an Action waiting for approval, read as a
refusal. A query test now passes as refused only when the runtime refuses
it; an empty answer is reported inconclusive. An invoke test counts only
authorization blockers, and a missing target is reported inconclusive.
Mutations `policy-tests.empty-is-refused`, `policy-tests.missing-target-is-refused`.

### M2. `withholds` and `returns` accepted property names the Type does not have. Fixed.

A misspelt `withholds` passed forever. `loadTests` now checks every Type
and property name against the model (computed properties included) and
names the one probably meant. A `withholds` over an empty answer is
inconclusive, and a query test reads every page, up to 1,000 objects,
instead of the first 50. Mutation `policy-tests.withholds-ignored`.

### M3. A connection failure sent internal host names and ports to callers. Fixed.

The driver's message (`connect ECONNREFUSED 10.0.3.7:5432`) went into the
503 problem. The problem now says only which system cannot be reached;
the driver's text stays in `cause`, which the server logs.

### M4. `typesys dev` could stop the last good build when a rebuild failed in `serve`. Fixed.

The trial build used in-memory state, so a broken `state` section passed
the trial, the running server was closed, and `serve` then failed. The
trial now builds with the deployment's own state, and the port the first
build got is kept for every rebuild.

### M5. `onboard propose --deployment` overwrote the pack archive the previous deployment pinned. Fixed.

Proposing again at the same version replaced the archive, so the previous
deployment no longer built and the upgrade check could not run. It now
refuses to replace an archive holding another digest, and asks for the
next `--version`; the deployment as it was is kept as
`<name>.deployment.previous.json`, and the printed check names it.

### M6. `init` reported success for names the server cannot read. Fixed.

A table or column whose name is not a plain identifier
(`odd."order-items"`, `"unit price"`) was onboarded and written, and the
first `deploy build` failed. `init` now refuses before writing anything,
naming each, and suggests a view with plain names.

### M7. A column-level grant made the startup check refuse a deployment that reads correctly. Fixed.

The check asked only for table-level SELECT. It now asks for each column
the mapping reads when the table-level check fails, and names only the
columns it may not read. Test: `sources.test.ts`.

### M8. A busy database made the server refuse to start. Fixed.

Only SQLSTATE classes 08 and 57 counted as unavailable, so
`53300 too_many_connections` during a rolling deploy crashed the new pod.
Classes 53 and 40 and 55P03 now count as unavailable and retryable; 28 (bad
credentials) and 3D000 (no such database) as unavailable and not
retryable, with a message naming the deployment's connection settings.

## Low

**L1. One `deploy check` run could write an acceptance and pass with it. Fixed.**
`--write-acceptance` and `--accept` together are refused, and writing an
acceptance when nothing blocks writes nothing.

**L2. `init` echoed a connection string given in place of its variable. Fixed.**
A value that is not an environment variable's name is refused without being repeated.

**L3. Closing a dev session during a rebuild left it watching. Fixed.**
A closed session no longer rebuilds, watches or serves.

**L4. The startup mapping check is skipped for good when the database is unreachable at start. Kept.**
The server starts, warns, and reports the source through `/readyz`; a
mapping problem then shows as the non-retryable 503 on the first read of
that Type, naming the source and `typesys deploy build`. Re-checking on a
backoff is a later refinement.

**L5. Classified columns dropped out of what `init` reported. Fixed.**
They are listed with their marking in the summary and the README, as
served to no drafted persona.

**L6. The "has rows" probe swallowed errors. Fixed.**
A table that cannot be probed is drafted as having rows, so its steward
test fails visibly, and `init` prints a warning with the error code.

## Checked and not a finding

SQL injection in `checkMapping` (parameterized; identifiers validated);
reusing or forging an acceptance (bound to both build ids, which hash the
deployment and every pack digest; every line must match exactly, and an
accepted line that no longer blocks is itself blocking); token strength
(72 random bits; messages show four characters); `GET /` for anonymous
callers (nothing `/version` did not already show); connection strings on
disk (`$secret` references only); every shipped deployment still builds;
the command shims.
