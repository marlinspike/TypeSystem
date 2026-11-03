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

> **Scope note.** The image's default deployment is the in-memory airforce
> demonstration, so it does not itself read Postgres or Redis. The Postgres
> and Redis services below, and the migration step, are the infrastructure a
> *real* domain build wires in (a Postgres `RegistryStore`/adapter and the
> shared `RedisCache`/`RedisRateLimiter`). `npm run load-test` is what exercises
> the shared-Redis path across replicas today.

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
behave as one (a real domain build reads them — the demo server is in-memory).

## Health endpoints

The HTTP transport exposes two unauthenticated, side-effect-free endpoints an
orchestrator gates traffic on:

- `GET /healthz` — **liveness**: the process is up. No dependency checks.
- `GET /readyz` — **readiness**: the registry store answers a cheap read, so
  this replica can serve. Returns `503` when the store is unreachable (with a
  Postgres-backed `RegistryStore`, that means Postgres is down).

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

```bash
# 1. Build, tag, and push to your registry; edit deploy/k8s/typesys.yaml's image ref.
# 2. Create the Secret (never commit real values — see deploy/k8s/secret.example.yaml):
kubectl create secret generic typesys-secrets \
  --from-literal=DATABASE_URL='postgresql://user:pass@host:5432/db' \
  --from-literal=REDIS_URL='redis://host:6379'
# 3. Put the deployment file in a ConfigMap; the Deployment mounts it at /etc/typesys/deployment.json:
kubectl create configmap typesys-deployment --from-file=deployment.json=deployments/airforce.deployment.json
# 4. Apply the manifests (ConfigMap, migration Job, Deployment, Service):
kubectl apply -f deploy/k8s/typesys.yaml
# Upgrading: check, replace the file, restart.
npx typesys deploy check deployments/airforce.deployment.json next.deployment.json
kubectl create configmap typesys-deployment --from-file=deployment.json=next.deployment.json -o yaml --dry-run=client | kubectl apply -f -
kubectl rollout restart deployment/typesys-mcp-server
```

The `Deployment` runs 2 replicas with `livenessProbe`/`readinessProbe` pointed
at `/healthz` and `/readyz`. The migration `Job` runs `migrate:postgres` to
completion. These are flat manifests on purpose; template them (Helm/Kustomize)
and add resource limits, an HPA, and a PodDisruptionBudget for a real deployment.

## Environment variables

Only what the code actually reads:

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `PORT` | `packages/host/src/serve.ts` | `3939` | The HTTP port. |
| `TYPESYS_DEPLOYMENT` | `packages/host/src/serve.ts` | the image: `deployments/airforce.deployment.json` | The deployment file the server builds (ADR-0102). |
| `TYPESYS_PACKS_DIR` | `packages/host/src/load.ts` | the image: `/app/packs` | Where a deployment's pack archives are found, unless it names their files. |
| `MCP_ALLOWED_HOSTS` | `packages/host/src/serve.ts` | localhost only | Host names the server answers to (ADR-0053). |
| *Each `$env` and `$secret` a deployment names* | `packages/host/src/host.ts` | the reference's `default`, for `$env`; for `$secret`, only in a demo | Service addresses and credentials. A real deployment that names an unset secret does not start, and says which. |
| `DATABASE_URL` | `@typesys/adapter-postgres` and `@typesys/registry-store-postgres` connection pools; the `migrate` step | — | Used by a Postgres-backed build and by migrations; the in-memory demo server ignores it. |
| `PG_STATEMENT_TIMEOUT_MS` | `@typesys/adapter-postgres` pool ([ADR-0026](../adr/0026-adapter-call-resilience.md)) | unset (no DB-side limit) | Optional native query deadline. |
| `REDIS_URL` | The multi-instance tests and `npm run load-test`; a real build passes it to `RedisCache`/`RedisRateLimiter` | — | Not read by library code directly — it's the conventional place to put the Redis URL. |

Identity (OIDC/JWT, [ADR-0018](../adr/0018-oidc-identity-resolution.md)) is
the deployment file's `identity` (`{ "kind": "oidc", "issuer": { "$env": "OIDC_ISSUER" } }`).
OpenTelemetry ([ADR-0017](../adr/0017-observability.md)) is configured in code
(the SDK you register).
