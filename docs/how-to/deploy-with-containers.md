# Deploy with containers

One image serves every deployment ([ADR-0102](../adr/0102-one-generic-host-builds-a-declared-deployment.md)):
the generic server, `packages/host/dist/serve.js`, builds the governed runtime
from the deployment file `TYPESYS_DEPLOYMENT` names and serves MCP at `/mcp`
and the governed API under `/api`. What a deployment is (its packs, sources,
rules, identity, personas and consumers) is in that file, not in the image.
Upgrading is a new file or a new image, checked with `typesys deploy check`
([ADR-0104](../adr/0104-an-upgrade-is-checked-before-it-rolls.md)), then a
restart. `GET /version` on any replica names the build it serves
([ADR-0101](../adr/0101-every-audit-row-names-its-build.md)).

**Your own deployment.** `typesys deploy package` writes the files that run
it on the published image, `ghcr.io/marlinspike/typesystem:<version>`
([ADR-0119](../adr/0119-a-deployment-is-packaged-to-run.md),
[ADR-0120](../adr/0120-one-published-image-runs-every-deployment.md)):

```bash
npx typesys deploy promote my.deployment.json --issuer <url> --audience <aud>   # once, from a development deployment
npx typesys deploy package my.shared.deployment.json --target compose --out deploy   # or --target k8s
cd deploy && cp .env.example .env && docker compose up -d
```

[Operate a deployment](operate-a-deployment.md) walks through it, with
sign-in, upgrades, key rotation and telemetry. The rest of this page describes
the image and the reference files in this repository, which serve the airforce
demonstration.

```bash
docker build -t typesys .
docker run -p 3939:3939 typesys                      # deployments/airforce.deployment.json
docker run -p 3939:3939 \
  -v $PWD/my.deployment.json:/etc/typesys/deployment.json \
  -e TYPESYS_DEPLOYMENT=/etc/typesys/deployment.json \
  -e MY_SERVICE_URL=https://svc.internal -e MY_SERVICE_KEY=... typesys
curl localhost:3939/version
```

Below: reference artifacts for running it as a container, locally with Docker Compose, and as a reference
Kubernetes deployment (ADR-0029). They make the multi-replica design of
[ADR-0025](../adr/0025-multi-instance-deployment.md) something you can actually
run — they are **not** a production-blessed deployment (see
[`PRODUCTION-READINESS.md`](../PRODUCTION-READINESS.md) for what still stands
between this and real traffic: image scanning, secrets management, TLS, and more).

> **What the replicas share.** Compose and the Kubernetes manifests serve
> `deployments/airforce-durable.deployment.json`, the airforce demonstration
> with its state declared ([ADR-0106](../adr/0106-a-deployment-declares-where-its-state-lives.md)):
> the audit trail and the workflow journal in Postgres, the cache and the rate
> limit in Redis. Every replica writes its audit rows to Postgres as its own hash
> chain, and `typesys audit verify` checks them all
> ([ADR-0105](../adr/0105-the-audit-trail-can-be-verified.md)). The image's
> default, `deployments/airforce.deployment.json`, is still the in-memory
> demonstration, for a quick `docker run`.

## Topology

`docker compose up --build --scale app=2` (and the reference Kubernetes
manifests) stand up this shape — a load balancer over N stateless app replicas,
a one-shot migration that runs first, and the shared Postgres/Redis a real
domain build uses (ADR-0025):

```mermaid
flowchart TB
    client["MCP client / app"] --> lb["nginx / k8s Service<br/>(load balancer)"]
    lb --> app1["app replica<br/>/healthz · /readyz"]
    lb --> app2["app replica<br/>/healthz · /readyz"]
    migrate["migrate (one-shot)<br/>advisory-locked, runs first"] -->|creates schema| pg[("PostgreSQL")]
    app1 --> pg
    app2 --> pg
    app1 --> redis[("Redis<br/>shared cache + rate limiter")]
    app2 --> redis
```

Only the `app` replicas serve traffic; `migrate` runs to completion before they
start, and Postgres/Redis are the shared state that makes several replicas
behave as one: a replica refuses to start against a database it cannot reach or that is not migrated.

## Health endpoints

The HTTP transport exposes two unauthenticated, side-effect-free endpoints an
orchestrator gates traffic on:

- `GET /healthz` — **liveness**: the process is up. No dependency checks.
- `GET /readyz` — **readiness**: the registry store answers a cheap read, and
  every store the deployment's `state` declares answers (`SELECT 1` on each
  Postgres, `PING` on each Redis), so this replica can serve. Returns `503`
  when any of them is unreachable.

## Build the image

```bash
docker build -t typesys-mcp-server:latest .
```

Multi-stage (`Dockerfile`): a build stage compiles every workspace (`npm ci &&
npm run build`), and a slim non-root runtime stage runs the generic server,
`packages/host/dist/serve.js`, on `TYPESYS_DEPLOYMENT` (default
`deployments/airforce.deployment.json`), with the pack archives in `/app/packs`
and a `HEALTHCHECK` against `/healthz`.

## Run locally with Docker Compose

```bash
docker compose up --build --scale app=2
```

Stands up Postgres, Redis, a one-shot `migrate` job (the advisory-lock-safe
migrations of ADR-0025), two `app` replicas, and an nginx load balancer. Reach
the server through the balancer:

```bash
curl http://localhost:8080/healthz
```

## Deploy to Kubernetes (reference)

For your own deployment, `typesys deploy package <file> --target k8s` writes a
Kustomize directory (`kubectl apply -k`). The flat reference below serves the
airforce demonstration:

```bash
# 1. Use the published image, or build, tag, and push to your registry; edit deploy/k8s/typesys.yaml's image ref.
# 2. Create the Secret (never commit real values — see deploy/k8s/secret.example.yaml):
kubectl create secret generic typesys-secrets \
  --from-literal=DATABASE_URL='postgresql://user:pass@host:5432/db' \
  --from-literal=REDIS_URL='redis://host:6379'
# 3. Put the deployment file in a ConfigMap; the Deployment and the migration Job mount it at /etc/typesys/deployment.json:
kubectl create configmap typesys-deployment --from-file=deployment.json=deployments/airforce-durable.deployment.json
# 4. Apply the manifests (migration Job, Deployment, Service):
kubectl apply -f deploy/k8s/typesys.yaml
# Upgrading: check, replace the file, restart.
npx typesys deploy check deployments/airforce-durable.deployment.json next.deployment.json
kubectl create configmap typesys-deployment --from-file=deployment.json=next.deployment.json -o yaml --dry-run=client | kubectl apply -f -
kubectl rollout restart deployment/typesys-mcp-server
```

The `Deployment` runs 2 replicas with `livenessProbe`/`readinessProbe` pointed
at `/healthz` and `/readyz`. The migration `Job` runs `node
packages/host/dist/serve.js migrate` on the mounted deployment
([ADR-0117](../adr/0117-typesys-migrate-reads-the-deployment.md)) to
completion.

## Environment variables

Only what the code actually reads:

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `PORT` | `packages/host/src/serve.ts` | `3939` | The HTTP port. |
| `TYPESYS_DEPLOYMENT` | `packages/host/src/serve.ts` | the image: `deployments/airforce.deployment.json` | The deployment file the server builds (ADR-0102). |
| `TYPESYS_PACKS_DIR` | `packages/host/src/load.ts` | the image: `/app/packs` | Where a deployment's pack archives are found, unless it names their files. |
| `MCP_ALLOWED_HOSTS` | `packages/host/src/serve.ts` | localhost only | Host names the server answers to (ADR-0053). |
| *Each `$env` and `$secret` a deployment names* | `packages/host/src/host.ts` | the reference's `default`, for `$env`; for `$secret`, only in a demo | Service addresses and credentials. A real deployment that names an unset secret does not start, and says which. |
| *`<NAME>_FILE` for each secret* | `packages/host/src/host.ts` | — | The secret read from that file instead (a trailing newline dropped): Compose secrets and Kubernetes secret volumes ([ADR-0119](../adr/0119-a-deployment-is-packaged-to-run.md)). |
| `DATABASE_URL` | `@typesys/adapter-postgres` and `@typesys/registry-store-postgres` connection pools; the `migrate` step | — | Used by a Postgres-backed build and by migrations; the in-memory demo server ignores it. |
| `PG_STATEMENT_TIMEOUT_MS` | `@typesys/adapter-postgres` pool ([ADR-0026](../adr/0026-adapter-call-resilience.md)) | unset (no DB-side limit) | Optional native query deadline. |
| `REDIS_URL` | The multi-instance tests and `npm run load-test`; a real build passes it to `RedisCache`/`RedisRateLimiter` | — | Not read by library code directly — it's the conventional place to put the Redis URL. |

Identity (OIDC/JWT, [ADR-0018](../adr/0018-oidc-identity-resolution.md),
[ADR-0116](../adr/0116-clients-sign-in-through-the-deployments-provider.md)) is
the deployment file's `identity` (`{ "kind": "oidc", "issuer": { "$env": "OIDC_ISSUER" }, "audience": "api://my-server" }`);
a client without a token is told where to sign in. OpenTelemetry is the
deployment's `runtime.telemetry` (`{ "otlpEndpoint": "http://otel-collector:4318" }`,
[ADR-0121](../adr/0121-telemetry-and-request-logs-are-declared.md)), and every
request is logged as one JSON line on stdout.

## Sign and check the audit trail

A deployment that is not marked `"demo": true` must keep a signed audit trail
in Postgres. Make a key pair once:

```bash
npx typesys audit keygen --key-id audit-1 --out-dir .
# wrote ./audit-1.private.pem (put it in the secret state.audit.signing.key names) and ./audit-1.public.pem
```

The command also prints the `signing` and `verifyKeys` entries to paste into
the deployment's `state.audit`. Store the private key as the `AUDIT_SIGNING_KEY`
secret (see `deploy/k8s/secret.example.yaml`); the public key is not secret and
lives in the document. Then, from anywhere that can reach the database:

```bash
npx typesys audit verify deployment.json                 # every chain, every row, every signature
npx typesys audit verify --witness witness.json deployment.json   # also catches a chain deleted whole
npx typesys audit export deployment.json --out trail.jsonl
npx typesys audit verify --file trail.jsonl deployment.json   # offline, against the export
npx typesys audit prune deployment.json                  # deletes rows older than state.audit.retainDays, only behind a signed checkpoint
```

`verify` exits 1 and names the row when a row was edited, deleted, reordered or
cut off, or when a checkpoint's signature or key does not check. Run `prune`
on a schedule (a Kubernetes CronJob) if the deployment sets `retainDays`.

The server should sign in as a role that may read and append its state but
does not own it (ADR-0124). Name the owner in `state.audit.ownerUrl` (and
`state.workflows.ownerUrl`); `npx typesys migrate` signs in as the owner,
creates the server's role from the user and password in `url` if it is
missing, and grants it SELECT and INSERT only. That role cannot lift the
append-only triggers, delete, truncate or drop, so a stolen server credential
cannot rewrite the trail. `prune` signs in as the owner too. A server whose role
owns its tables starts with a warning.

The one thing an owner could still do unseen is delete a chain whole, with its
checkpoints: what is left verifies. `--witness <file>` keeps, outside the
database, the newest checkpoint and head of every chain a passing verification
saw, and the next verification fails with `[vanished]` if any of them is gone.
Keep the witness file where the database's owner cannot write it; the packages
from `typesys deploy package` mount a volume for it and run verify with it.
