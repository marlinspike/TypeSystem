# Deploy with containers

Reference artifacts for running the MCP server (the Streamable HTTP transport,
ADR-0021) as a container, locally with Docker Compose, and as a reference
Kubernetes deployment (ADR-0029). They make the multi-replica design of
[ADR-0025](../adr/0025-multi-instance-deployment.md) something you can actually
run — they are **not** a production-blessed deployment (see
[`PRODUCTION-READINESS.md`](../PRODUCTION-READINESS.md) for what still stands
between this and real traffic: image scanning, secrets management, TLS, and more).

> **Honest scope note.** The shipped server (`bin-http.js`) uses the in-memory
> airforce testbed, so it does not itself read Postgres or Redis. The Postgres
> and Redis services below, and the migration step, are the infrastructure a
> *real* domain build wires in (a Postgres `RegistryStore`/adapter and the
> shared `RedisCache`/`RedisRateLimiter`). `npm run load-test` is what exercises
> the shared-Redis path across replicas today.

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
npm run build`), and a slim non-root runtime stage runs
`packages/mcp-server/dist/bin-http.js` with a `HEALTHCHECK` against `/healthz`.

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
# 3. Apply the manifests (ConfigMap, migration Job, Deployment, Service):
kubectl apply -f deploy/k8s/typesys.yaml
```

The `Deployment` runs 2 replicas with `livenessProbe`/`readinessProbe` pointed
at `/healthz` and `/readyz`. The migration `Job` runs `migrate:postgres` to
completion. These are flat manifests on purpose; template them (Helm/Kustomize)
and add resource limits, an HPA, and a PodDisruptionBudget for a real deployment.

## Environment variables

Only what the code actually reads:

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `PORT` | `@typesys/mcp-server` (`bin-http`) | `3939` | The HTTP port — the only variable the shipped demo server reads. |
| `DATABASE_URL` | `@typesys/adapter-postgres` and `@typesys/registry-store-postgres` connection pools; the `migrate` step | — | Used by a Postgres-backed build and by migrations; the in-memory demo server ignores it. |
| `PG_STATEMENT_TIMEOUT_MS` | `@typesys/adapter-postgres` pool ([ADR-0026](../adr/0026-adapter-call-resilience.md)) | unset (no DB-side limit) | Optional native query deadline. |
| `REDIS_URL` | The multi-instance tests and `npm run load-test`; a real build passes it to `RedisCache`/`RedisRateLimiter` | — | Not read by library code directly — it's the conventional place to put the Redis URL. |

Identity (OIDC/JWT, [ADR-0018](../adr/0018-oidc-identity-resolution.md)) and
OpenTelemetry ([ADR-0017](../adr/0017-observability.md)) are configured in code
(the `IdentityResolver` you pass, the SDK you register), not through environment
variables the server reads on its own.
