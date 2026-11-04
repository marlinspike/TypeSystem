# Ease of use: your database, governed, in five commands (2026-11-03)

What it takes a newcomer to go from a clean clone to a governed read of
their own PostgreSQL table, measured before and after the work in
ADR-0110 to ADR-0115. Linux container, 4 cores, Node 22.23, PostgreSQL 16
on localhost, npm cache warm. The database is `shop`: `customers`
(id, full name, email, credit limit, region, tier), `orders` with a
foreign key to it, and `widgets`.

## Before (main at e792c16)

Tried by hand, following the README and the quickstart.

| Step | What happened |
|---|---|
| `git clone`, `npm install` | Fine (about 20 s) |
| The quickstart's first command | Crashed: `ERR_MODULE_NOT_FOUND …/@typesys/core/dist/index.js`, because nothing said to run `npm run build` |
| `npm run build`, then `npx typesys …` | `npm error could not determine executable to run`: npm links a workspace's bin only if its target exists at install time; a second `npm install` was needed |
| `typesys onboard collect` | `ENOENT` until the `--out` directory was made by hand |
| `onboard propose`, `review --accept-rest`, `propose` again | A good pack and `adapters.json`, and four policy names to write |
| The deployment | Written by hand, about 30 lines: the pack digest copied, `adapters.json` retyped as a `postgres` source, four rules, tokens, personas |
| `typesys deploy build` | First try: `token "sale…" names no persona`, with no hint of a persona's shape |
| Serve | `node packages/host/dist/serve.js …` worked |
| A mistyped column in the deployment | Built, served, and answered every read of that Type with a bare 500 |
| `typesys deploy check` on a meant widening | Blocked, with no way to say it was meant |

About eleven commands plus a hand-written document, two blockers in the
first two minutes, and a class of mistake (a column name) that reached
callers as a 500.

## After (this branch)

Scripted from a fresh `git clone` of the branch, each step timed:

```
   1.2s  git clone -q /home/claude/TypeSystem TypeSystem
  14.5s  npm install --no-audit --no-fund
   6.9s  npm run build
   1.1s  npx typesys init shop --from postgres SHOP_URL --schema public
   1.7s  npx typesys dev (until serving and tests run)
   0.0s  curl -sf -X POST localhost:4392/api/query -H authorization: Bearer dev-reader-… -d {"type":"shop.Customer","limit":1}
{"items":[{"typeName":"shop.Customer","objectId":"C-1","values":{"customerId":"C-1","creditLimit":5000,"region":"EU","tier":"gold"}}],"nextCursor":"1"}
TOTAL 25.4s
```

Five commands after the clone (`npm install`, `npm run build`, `typesys
init`, `typesys dev`, and the first call `dev` prints), no hand-written
file, 25 seconds of machine time. The reader's read withholds `fullName`
and `email`; the steward's returns them; a call without a token is
refused with a 403 problem. The eight drafted policy tests pass.

The time a person spends is reading, not typing: `init` prints what it
wrote and the next command, and `dev` prints each token, the `curl`, and
the `claude mcp add` line.

## The mistakes, after

| Mistake | Before | After |
|---|---|---|
| A command before `npm run build` | Module-not-found stack trace | `typesys: this package is not built yet. Run npm run build at the repository root, then try again.` |
| `npx typesys` on a fresh clone | Not linked | Linked by the committed shim in each package's `bin/` |
| A column the table does not have | Built and served; bare 500 on read | `deploy build`, startup and `dev` all report `public.customers has no column "e_mail" (did you mean "email"?)`; `dev` keeps the last good build |
| A property the Type does not have, or a Type no pack has | Built; failed on read | Reported with the name probably meant |
| The database down, or a grant missing | Bare 500 | 503 naming the source that cannot be reached; 502 naming the refusal |
| A token naming an undeclared persona | `names no persona` | The persona's shape, ready to paste |
| `{"typeName": …}` instead of `{"type": …}` in a query | `Invalid query` | The query's fields, `typeName` answered with "did you mean type?", and an example |
| A meant widening | Blocked, no way through | `--write-acceptance` then `--accept`, bound to the two build ids |
| YAML Types | Could not be served by the generic host | `typesys pack build` |

## How it was checked

The scripted run above, plus the paths it does not cover, run by hand
against the same database: a typo while `dev` runs (reported, last build
kept, served again once fixed), a widening blocked then accepted, a new
column picked up with `onboard propose --deployment` (pack 1.0.0 to
1.1.0, rules untouched). Automated: `packages/host/test/sources.test.ts`,
`packages/host/test/usability.test.ts`, `packages/onboard/test/init.test.ts`,
`packages/cli/test/pack-build.test.ts`, and `deployments/airforce.tests.json`.
