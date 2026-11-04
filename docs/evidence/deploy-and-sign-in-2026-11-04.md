# From a laptop to a shared, signed-in server (2026-11-04)

What it takes to turn the deployment `typesys init --from postgres` drafts
into one a team signs in to, measured before and after the work in ADR-0116
to ADR-0121. Linux container, 4 cores, Node 22.23, PostgreSQL 17 on
localhost, the same two-table `shop` database as the
[ease-of-use evidence](ease-of-use-2026-11-03.md), and a local OpenID Connect
provider (discovery document, key set, signed RS256 tokens with a `groups`
claim). The container has the Docker client and Compose but no Docker daemon,
so the image's steps were run in a directory instead of a container, and the
Compose and Kubernetes files were checked but not started.

## Before (main at 66cba7c)

| Step | What happened |
|---|---|
| Build the image from the Dockerfile | Failed: `npm run build` reads `scripts/build-clients.ts`, which the Dockerfile did not copy |
| Run the built server as the image does (`node packages/host/dist/serve.js`) | Hung forever: a top-level `await main()` waited on the airforce extension, which imports `@typesys/host` |
| Make the development deployment shareable | A hand edit of `identity`, `demo` and `state`, plus `audit keygen`, with nothing to say which fields |
| Migrate its database | `npm run migrate:postgres` reads `DATABASE_URL`, not the deployment, runs from sources, and creates the demonstration's tables |
| `deploy build` against an unmigrated database | Passed; the server then refused to start |
| Run it in Compose or Kubernetes | The shipped files serve the airforce demonstration only; the ConfigMap leaves out the packs |
| An MCP client with no token | `initialize` answered `200` as anonymous: no `401`, no protected resource metadata, so no client could find where to sign in |
| A token the provider issued for another application | Accepted when `identity.audience` was left out, which nothing required |
| A provider other than one serving `/.well-known/jwks.json` at its issuer (Entra ID, Okta, Keycloak) | Keys not found: no OpenID Connect discovery |
| Map provider groups to roles | Not possible |
| Request logs, traces | None without code |

## After (this branch)

The commands, run in sequence on the `shop` database:

| Command | Time | Result |
|---|---|---|
| `typesys init shop --from postgres SHOP_URL --schema public` and `typesys deploy promote shop.deployment.json --issuer http://localhost:5600 --audience api://shop --roles-claim groups` | 1.6 s together | `shop.shared.deployment.json`, `secrets/audit-1.private.pem`, the secrets to provide and the next commands |
| One hand edit | | `identity.roleMap`: `{"shop-readers": ["reader"], "shop-stewards": ["reader", "steward"]}` |
| `deploy check`, `deploy build` (before migrating), `migrate`, `deploy build`, `deploy package --target compose` | 6.0 s together | check OK (`identity, demo, state` changed); build FAIL naming the 8 pending migrations; migrate applied them; build `sha256:e8fe033acd6e…`; 7 files written |
| `docker compose config -q` on the output | | valid |

The packaged deployment, served the way the image serves it (the same
command, `_FILE` for the signing key):

| Call | Answer |
|---|---|
| `POST /mcp` with no token | `401`, `WWW-Authenticate: Bearer resource_metadata="http://localhost:3990/.well-known/oauth-protected-resource"` |
| `GET /.well-known/oauth-protected-resource/mcp` | `{"resource":"http://localhost:3990","authorization_servers":["http://localhost:5600"],...}` |
| A token in `shop-readers` | `200`, the customer without its name and email |
| A token for audience `other-api` | `401`, `error="invalid_token"` |
| A token in no mapped group | `403` |
| `typesys audit verify` afterwards | `OK: 5 rows in 1 chain verify.` |

Each request wrote one JSON line (`"route":"/api/objects/shop.Customer/:id"`),
with no id, token or value in it. The MCP SDK's own `auth()` client, given
only the server's URL and a `401`, found the provider through the metadata and
discovery documents (`packages/host/test/sign-in.test.ts`).

The image's build stage reproduced in a directory: `npm ci`, `npm run
build` and the prune took 23 s, leaving 218 MB under `/app` (OpenTelemetry's
SDK and exporters are part of it). `node packages/host/dist/serve.js
deployments/airforce.deployment.json --check` then built
`sha256:d80094942624…` and exited, where on main it hung.

## Not measured here

Pulling the published image, `docker compose up` and `kubectl apply -k`
need a Docker daemon and a cluster; the `Image` workflow runs the image's own
smoke check (serve, read as a viewer, migrate) on GitHub when a maintainer
starts it. Sign-in against Microsoft Entra ID, Okta and Keycloak themselves is
untested; the local provider follows the same discovery and token shapes.
