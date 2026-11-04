# Quickstart

Your own PostgreSQL database, served governed, in five commands: every
table becomes a Type, every foreign key a relationship, every column that
looks personal is withheld from everyone but a steward, every read is
audited, and the same server answers both people (an HTTP API) and AI
agents (MCP). No code is written. Everything below was run against this
repository and a two-table `shop` database; the output is pasted as it
came out.

If you have no database to hand, skip to
[See it without a database](#see-it-without-a-database).

## 1. Install and build

```bash
git clone https://github.com/marlinspike/TypeSystem && cd TypeSystem
npm install
npm run build
```

`npx typesys` works from here on. (Running a command before
`npm run build` says so and exits, instead of failing with a module
error.)

## 2. Onboard the database into a deployment

The connection string stays in an environment variable. `typesys init`
reads the catalog and whether each table has rows; it never reads a row's
values and never writes the connection string anywhere.

```bash
export SHOP_URL=postgres://user:password@localhost/shop
npx typesys init shop --from postgres SHOP_URL --schema public
```

```
Onboarded shop into "shop": 3 Types, 15 properties, 1 relationship, 3 sensitive fields
  shop.Customer  (sensitive: email, fullName)
  shop.Order
  shop.Widget  (sensitive: name)

A reader is returned every other column. Check none of these should be kept from readers:
  shop.Customer: creditLimit, customerId, region, tier
  shop.Order: customerId, orderId, placedAt, status, total
  shop.Widget: id, status, tracking

Wrote shop/shop.deployment.json, shop/shop.tests.json, shop/packs/shop-1.0.0.typesys-pack.json, shop/README.md and shop/onboarding/
Policies (each one role, nothing open to everyone): shop.read-customer, shop.read-order, shop.read-widget, shop.contact, shop.personal-name

Tokens (typesys dev answers them on 127.0.0.1 only):
  reader   dev-reader-3C2zEqCh3uhL
  steward  dev-steward-OBatDZEMfEPe

Next:
  npx typesys dev shop/shop.deployment.json
```

What it wrote (ADR-0111):

| File | What it is |
|---|---|
| `packs/shop-1.0.0.typesys-pack.json` | The model: Types, the relationship, the policy each Type and sensitive property names |
| `shop.deployment.json` | What the generic server serves: the pack by digest, the `postgres` source mapping every table and column, one draft rule per policy, personas and their tokens |
| `shop.tests.json` | Policy tests: a reader lists each Type without its sensitive fields, a steward sees them, anyone else is refused |
| `onboarding/` | What was collected, proposed and accepted, so `typesys onboard` can run again as the schema changes |
| `README.md` | The same, for whoever opens the folder next, with every column a reader is returned |

**Check what a reader is returned.** Onboarding marks a column sensitive
from its name and documentation (names, emails, phone numbers, government
and tax ids, card and bank details, dates of birth, locations,
credentials); every other column goes to every reader. `init` lists them.
To keep one from readers, remove its column from `sources` in the
deployment and it is not read at all.

`init` never replaces a file already in the directory without `--force`
(and then keeps each as `<file>.bak`).

The deployment is marked `demo: true`, and `typesys dev` answers its fixed
tokens on 127.0.0.1 only. Before serving it to anyone else, replace `identity` with your OIDC
provider (see [how-to/deploy-with-containers.md](how-to/deploy-with-containers.md)).

## 3. Serve it

```bash
npx typesys dev shop/shop.deployment.json
```

```
shop is serving (build sha256:992ced6e1975…)
  API  http://localhost:3939/api        MCP  http://localhost:3939/mcp        index  http://localhost:3939/

Personas and their tokens (fixed tokens, answered on this machine only):
  reader     dev-reader-3C2zEqCh3uhL   roles: reader
  steward    dev-steward-OBatDZEMfEPe   roles: reader, steward

A first call, as reader:
  curl -s -X POST http://localhost:3939/api/query -H 'authorization: Bearer dev-reader-3C2zEqCh3uhL' -H 'content-type: application/json' -d '{"type":"shop.Customer","limit":5}'
Connect Claude Code to it, as reader:
  claude mcp add --transport http shop http://localhost:3939/mcp --header "Authorization: Bearer dev-reader-3C2zEqCh3uhL"
Policy tests (shop/shop.tests.json):
  ✓ a reader lists shop.Customer without email, fullName
  ✓ a steward sees email, fullName on shop.Customer
  ✓ anyone else is refused shop.Customer
  ✓ a reader lists shop.Order
  ✓ anyone else is refused shop.Order
  ✓ a reader lists shop.Widget without name
  ✓ a steward sees name on shop.Widget
  ✓ anyone else is refused shop.Widget
PASS: 8 passed, 0 failed

Watching shop/shop.deployment.json, its packs and its tests. Ctrl-C to stop.
```

This is the same server a container runs (ADR-0102); `dev` adds the
welcome, the tests and a rebuild whenever the deployment, a pack or the
tests change (ADR-0112).

## 4. Read through it

The same query, as three callers:

```bash
curl -s -X POST localhost:3939/api/query -H 'authorization: Bearer dev-reader-3C2zEqCh3uhL' \
  -H 'content-type: application/json' -d '{"type":"shop.Customer","limit":1}'
```
```json
{"items":[{"typeName":"shop.Customer","objectId":"C-1","values":{"customerId":"C-1","creditLimit":5000,"region":"EU","tier":"gold"}}],"nextCursor":"1"}
```

As `steward` the same object carries `"fullName":"Ada Lovelace","email":"ada@example.com"`.
With no token:

```json
{"type":"https://typesys.dev/problems/forbidden","title":"Not authorized","status":403,"code":"forbidden","detail":"Not authorized: read shop.Customer","reason":"No object of this Type is readable by this subject"}
```

Every one of those reads is in the audit journal, with the build that
answered it.

## 5. Change it safely

**A mistake is caught before it serves.** Mistype a column in
`shop.deployment.json` while `dev` runs and it reports, and keeps serving
the last build that worked:

```
Changed: building shop/shop.deployment.json again
The deployment does not build:
  - sources["shop-db"]: shop.Customer.email: public.customers has no column "e_mail" (did you mean "email"?)
Still serving the last build that did: sha256:992ced6e1975…
```

`npx typesys deploy build shop/shop.deployment.json` runs the same check
against the database catalog (ADR-0110); a server refuses to start with
one, instead of answering bare 500s later.

**The rules are tested.** `npx typesys deploy test shop/shop.deployment.json`
runs `shop.tests.json` and exits 1 when one fails, so it belongs in CI. A
test whose answer cannot show its promise (a refusal over an empty table,
a misspelt property) fails as inconclusive rather than passing.
Add your own: each test reads, queries or previews an Action as a persona
and says what must be returned, withheld or refused (ADR-0113, and
[how-to/add-a-policy-rule.md](how-to/add-a-policy-rule.md)).

**A widening is blocked until someone accepts it.** Change `shop.contact`
to admit `reader` in a copy, `next.deployment.json`, and compare:

```bash
npx typesys deploy check shop/shop.deployment.json shop/next.deployment.json
```
```
shop sha256:992ced6e1975… → shop sha256:e9142b5f2afc…
BLOCKED: 4 reasons this must not roll as is.
  ✗ exposure: reader reads shop.Customer.email on shop.Customer/C-1 (now returned to reader, was withheld)
  ✗ exposure: reader reads shop.Customer.email on shop.Customer/C-2 (now returned to reader, was withheld)
  ✗ policy shop.contact now admits reader (on shop.Customer)
  ✗ widens: policy shop.contact (deciding shop.Customer.email) now admits a subject with role reader, on any object and in lists
  If this is meant: write an acceptance with --write-acceptance <file> --by <name> --why <reason>, review it, and pass it with --accept <file>.
```

If it is meant, record who accepted it and why, commit that file with the
change, and the check passes for exactly these two builds and nothing
else (ADR-0114):

```bash
npx typesys deploy check shop/shop.deployment.json shop/next.deployment.json \
  --write-acceptance shop/accept.json --by Reuben --why "support needs customer email"
npx typesys deploy check shop/shop.deployment.json shop/next.deployment.json --accept shop/accept.json
```
```
OK: 4 blocking changes accepted, nothing else blocks this upgrade.
  ✓ accepted by Reuben (support needs customer email): exposure: reader reads shop.Customer.email on shop.Customer/C-1 (now returned to reader, was withheld)
  ...
```

## See it without a database

```bash
npx typesys dev deployments/airforce.deployment.json
npx typesys deploy test deployments/airforce.deployment.json
```

The airforce deployment serves a squadron's aircraft from memory with
maintainer, viewer and anonymous personas; its tests show the viewer
withheld `readinessStatus` and anonymous refused.

## Author Types in YAML instead

When there is no database to start from, write the Types and build them
into a pack (ADR-0115):

```bash
npx typesys init ./fleet --name fleet             # scaffolds fleet/00-example.yaml
npx typesys validate ./fleet --bindings ./fleet/bindings.mjs
npx typesys pack build ./fleet --name fleet --version 1.0.0 --out packs/fleet-1.0.0.typesys-pack.json
```

`pack build` declares one source the Types are read from (`fleet-db`, a
`postgres` source, by default; `--source`, `--source-kind` change it), and
a deployment lists the pack and maps that source's tables. See
[how-to/add-a-type.md](how-to/add-a-type.md).

## Share it

The deployment `init` wrote answers fixed tokens on your machine. To serve it
to a team that signs in through your OpenID Connect provider, with a signed
audit trail in Postgres:

```bash
npx typesys deploy promote shop/shop.deployment.json --issuer https://login.example.com --audience api://shop
npx typesys migrate shop/shop.shared.deployment.json          # needs TYPESYS_STATE_URL
npx typesys deploy package shop/shop.shared.deployment.json --target compose --out deploy
```

[how-to/operate-a-deployment.md](how-to/operate-a-deployment.md) covers each
step, setting up Entra ID, Okta or Keycloak, and running it day to day.

## Where to go next

- **Change the model as the database changes** →
  [how-to/onboard-a-source.md](how-to/onboard-a-source.md) (`typesys onboard propose --deployment`)
- **Write real rules: attributes, row-level, Cedar** →
  [how-to/add-a-policy-rule.md](how-to/add-a-policy-rule.md)
- **Ship it as a container** →
  [how-to/deploy-with-containers.md](how-to/deploy-with-containers.md)
- **Let an AI agent use it over MCP** → [for-agents.md](for-agents.md)
- **Build your own TypeScript project on the runtime** →
  [how-to/start-a-project.md](how-to/start-a-project.md)
- **Why it is shaped this way** → [why-typesys.md](why-typesys.md) and
  [docs/adr/](adr/).
