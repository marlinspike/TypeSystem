# Operate a deployment

This guide picks up where [`typesys init --from postgres`](../quickstart.md)
leaves off: a development deployment that answers fixed tokens on your
machine. It takes that deployment to a server a team signs in to, and then
covers what running it involves: upgrades, keys, the audit trail and
telemetry. Each step is one command; the decisions are in
[ADR-0116](../adr/0116-clients-sign-in-through-the-deployments-provider.md) to
[ADR-0121](../adr/0121-telemetry-and-request-logs-are-declared.md) and
[ADR-0124](../adr/0124-the-server-cannot-erase-its-own-audit-trail.md).

## From development to shared

```bash
npx typesys deploy promote shop/shop.deployment.json \
  --issuer https://login.microsoftonline.com/<tenant-id>/v2.0 \
  --audience <api-application-id> --roles-claim roles
```

`promote` writes `shop/shop.shared.deployment.json` and leaves the original
alone. The shared one:

- is not a demo, and signs people in through your provider;
- tells an anonymous caller nothing about the model (`runtime.discovery:
  "authenticated"`), and names no roles in a refusal;
- keeps a signed audit trail in Postgres, written by a role that may only read
  and append: `state.audit.ownerUrl` names the tables' owner, which only
  `migrate` and `audit prune` sign in as. The private half of its new audit
signing key is in `shop/secrets/audit-1.private.pem`, which is git-ignored;
the public half is in the document. An argument shaped like an environment
variable name (`--issuer OIDC_ISSUER`) becomes a reference to that variable
instead of a literal.

Open the shared file and give `identity.roleMap` your provider's names. Each
key is a value your provider puts in the roles claim (a group, an app role);
each value is the deployment's roles it grants. A name that is not listed
grants nothing. `promote` drafts a group per role, granting what every persona
with that role also holds, so the steward group grants `reader` too:

```json
"roleMap": { "Shop.Readers": ["reader"], "Shop.Stewards": ["reader", "steward"] }
```

`typesys deploy test` checks each persona its tests run as against the map, and
fails one that no single group can make: a member of that group would be
refused what the tests allow.

Then check what promoting changed, ready the database and build:

```bash
npx typesys deploy check shop/shop.deployment.json shop/shop.shared.deployment.json
export TYPESYS_STATE_OWNER_URL=postgres://owner@db/shopstate    # owns the tables: migrate and prune only
export TYPESYS_STATE_URL=postgres://typesys_app:<password>@db/shopstate   # the server's own role
npx typesys migrate shop/shop.shared.deployment.json
npx typesys deploy build shop/shop.shared.deployment.json
```

`migrate` signs in as the owner, creates the tables and the server's role
(with the password `TYPESYS_STATE_URL` carries, if the role does not exist),
and grants that role SELECT and INSERT on the audit tables and nothing else.
It refuses a server role that is the owner or a superuser. `deploy build` fails,
naming the migrations, until `migrate` has run. A server whose role owns the
tables starts, but says at start what that gives away.

## Set up your provider

The server needs three things from the provider: its issuer, the audience its
tokens carry for this server, and the claim that holds roles or groups. Keys
are found through the issuer's discovery document
(`<issuer>/.well-known/openid-configuration`); set `identity.jwksUrl` only for
a provider that has none. Whatever you choose, decode one real token (at
jwt.io or with `cut -d. -f2 | base64 -d`) and compare its `iss`, `aud` and
roles claim with the deployment before anyone else tries.

**Microsoft Entra ID.** Register an application for the server and expose an
API on it (Application ID URI, at least one scope). Define app roles and assign
users or groups to them; the token's `roles` claim then carries the role
values, which are the keys of `roleMap`. Set
`"requestedAccessTokenVersion": 2` in the application's manifest: otherwise
Entra issues v1.0 tokens, whose `iss` is `https://sts.windows.net/<tenant-id>/`
and does not match the v2.0 issuer
`https://login.microsoftonline.com/<tenant-id>/v2.0` (Microsoft's
[access token documentation](https://learn.microsoft.com/entra/identity-platform/access-tokens)).
The audience of a v2.0 token is the application's client id.

**Okta.** Use a custom authorization server (the `default` one has the issuer
`https://<your-domain>/oauth2/default` and the audience `api://default`):
tokens from the org authorization server are meant for Okta's own APIs. Add a
`groups` claim to access tokens under the authorization server's claims, and
pass `--roles-claim groups`.

**Keycloak.** The issuer is `https://<host>/realms/<realm>`, exactly as tokens
carry it, scheme and port included. Realm roles are in `realm_access.roles`,
which `rolesClaim` reads as a dotted path. Out of the box a token's `aud` is
usually `account`: add an Audience mapper (in a client scope assigned to the
clients that call the server) that puts the server's client id in `aud`.

**MCP clients.** A client such as Claude Code that is pointed at
`https://<server>/mcp` gets `401` with a `resource_metadata` link, reads the
issuer from it and signs in there. Whether it can register itself depends on
the provider allowing dynamic client registration; otherwise register a
client for it and give the client its id. Set `identity.resource` to the
address clients use (`https://typesys.example.com`) when the server sits
behind a proxy that does not pass `Host` and `X-Forwarded-Proto` through, and
`identity.scopes` when the provider needs a scope named to issue a token for
the server.

## Package and run it

```bash
npx typesys deploy package shop/shop.shared.deployment.json --target compose --out deploy --host shop.example.com
cd deploy && cp .env.example .env    # fill it in
docker compose up -d
docker compose --profile ops run --rm audit-verify
```

Compose publishes the server on 127.0.0.1 only. Clients send a bearer token
with every request, so put a proxy that terminates TLS in front of it (Caddy,
nginx, a cloud load balancer), set `identity.resource` to its `https://` origin
and add its name to `MCP_ALLOWED_HOSTS`. For the bundled database, `owner.env`
holds the owner's password, made when you first package; only the database,
`migrate` and `audit-prune` read it. If you packaged before this existed, put
your old `STATE_DB_PASSWORD` in `owner.env` as `POSTGRES_PASSWORD` and in its
owner URL: the database keeps the password it was first started with.

Or, for Kubernetes:

```bash
npx typesys deploy package shop/shop.shared.deployment.json --target k8s --out k8s --host shop.example.com
cd k8s && cp secrets.env.example secrets.env   # fill it in, keep it out of git
cp owner.env.example owner.env                  # the owner: given to the migrate init container and the prune job only
kubectl apply -k .
```

With `--host`, `typesys.yaml` has an Ingress for those names serving TLS from
the Secret `typesys-<name>-tls`: create it, or let cert-manager fill it.

Both use `ghcr.io/marlinspike/typesystem:<version>`; pass `--image` for your
own registry. The Kubernetes files run `migrate` as an init container, so a
new replica never starts against an unmigrated database, and changing
`config.env`, `secrets.env` or the deployment rolls the pods (Kustomize puts a
hash of each in its name). Compose bundles a Postgres for the audit trail;
`--external-state` leaves it out and takes the state's connection string
(`TYPESYS_STATE_URL` unless you named another) from `.env`.

Any secret the deployment names can be given as a file: set `NAME_FILE` to
its path instead of `NAME`. The packaged files do this for the signing key.

## Upgrade

Change the deployment, then check it against what is running before it rolls:

```bash
npx typesys deploy check running.deployment.json next.deployment.json
```

A change that widens who reads what, breaks a consumer's pinned contract or
changes the model incompatibly is blocked until it is accepted on the record
(`--write-acceptance`, `--accept`). Then run `typesys deploy package` again
over the same directory with `--force`, and `docker compose up -d` or
`kubectl apply -k .`. Kubernetes rolls the two replicas with its default
rolling update, starting a new pod before stopping an old one; a new pod is
sent traffic only once `/readyz` says its database and stores answer. A new image version is the same: change `--image` (or the tag in the
files) and apply. `GET /version` on any replica names the build it serves.

## Rotate the audit signing key

```bash
npx typesys audit keygen --key-id audit-2 --out-dir shop/secrets
```

Add the new public key to `state.audit.verifyKeys` beside the old one, point
`state.audit.signing.keyId` at `audit-2`, give the server the new private key,
and roll. Keep the old public key in `verifyKeys` for as long as rows it
signed are kept: `typesys audit verify` needs it to check them.

## Check and trim the audit trail

`typesys audit verify <deployment.json>` checks every chain, row and
signature, and exits 1 naming the first row that was edited, deleted,
reordered or cut off.

From the database alone, a chain deleted whole, checkpoints and all, leaves
nothing to compare against. `--witness <file>` closes that: each run that
verifies records every chain's newest checkpoint and last row in the file, and
the next run reports `vanished` for any that is gone. Keep the file where the
database's owner cannot write. The packaged verifier keeps it in a volume of
its own and is given no private key, since verifying needs only the public
keys in the deployment. The Kubernetes files run it daily as a CronJob; run it
from Compose with the `ops` profile. With `state.audit.retainDays` set,
`typesys audit prune` deletes older rows, only behind a signed checkpoint,
signing in as `state.audit.ownerUrl` (the server's role may not delete), and
the Kubernetes files schedule it too. `typesys audit export --out trail.jsonl`
writes a copy that `audit verify --file` checks offline.

## Logs and telemetry

Every request is one JSON line on stdout:

```json
{"ts":"2026-11-04T14:07:47.387Z","level":"info","event":"http","deployment":"shop","build":"sha256:e8fe…","requestId":"88e29c67-…","method":"GET","route":"/api/objects/shop.Customer/:id","status":200,"ms":55.3}
```

`level` is `warn` for a 4xx and `error` for a 5xx. The route has object and
workflow-run ids taken out and no query string, and no header, token or value
is logged. A caller's `X-Request-Id` is kept when it is a plain token and
echoed in the response, so a report that quotes it can be found.
`"runtime": { "requestLog": false }` turns the log off.

A token the server refuses (expired, for another audience, badly signed, with
no `exp` or no `sub`) is also an audit row: subject `unauthenticated`, action
`sign-in`, the verifier's reason, and what the token claimed. A process writes
at most 60 such rows a minute; the next one says how many were left out.

To send traces and metrics to an OpenTelemetry collector:

```json
"runtime": { "telemetry": { "otlpEndpoint": { "$env": "OTEL_EXPORTER_OTLP_ENDPOINT" }, "serviceName": "shop", "metricsIntervalSeconds": 60 } }
```

Spans are sent to `<endpoint>/v1/traces` and metrics to `<endpoint>/v1/metrics`
over OTLP/HTTP, with `service.version` set to the build id. The generic server
puts no object or subject id on a span; the audit trail is where reads are
tied to objects and people.

## Publish the image

The `Image` workflow (`.github/workflows/image.yml`) builds the image, checks
that it serves the airforce demonstration and runs `migrate`, and publishes
`ghcr.io/<owner>/typesystem:<version>` and `:sha-<commit>`. It runs only when
a maintainer starts it from the Actions tab; tick `latest` to also tag
`:latest`. A new GitHub Container Registry package is private: make it public
once under the package's settings so `docker pull` works without signing in.
