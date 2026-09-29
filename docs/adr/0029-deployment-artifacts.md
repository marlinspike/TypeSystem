# 0029. Deployment Artifacts: Container Image, Compose, and Reference Kubernetes

## Status

Proposed — written ahead of implementation (an ADR-first workflow), unlike
the accepted ADRs that describe code already in the tree. It flips to
Accepted, with the concrete "proven, not assumed" evidence (test names,
measured numbers) filled in, when the implementation lands.

## Context

ADR-0025 designed the system to run as several replicas — shared Redis
`Cache`/`RateLimiter`, advisory-locked migrations, one budget per request —
and says to "point every replica at the same Postgres and Redis, and run
migrations as a deploy step." But the repository ships **no artifact that
runs a replica**: no `Dockerfile`, no `docker-compose.yml`, no Kubernetes
manifest, no `.dockerignore`. The deployable unit exists as code — the
Streamable HTTP MCP server (`packages/mcp-server/src/bin-http.ts`,
`createHttpApp` in `http-transport.ts`, ADR-0021) — and `npm run load-test`
already assumes several server processes, but there is nothing to package one
into an image or stand up the Postgres + Redis it needs.

Two smaller gaps sit inside this one. The HTTP transport exposes only the MCP
endpoint — there is no health or readiness probe for an orchestrator to gate
traffic on. And local development against the Postgres/Redis paths currently
means installing and wiring both by hand, which is friction the load test and
the multi-instance tests silently assume away. This work touches
`PRODUCTION-READINESS.md` items 6 (secrets), 7 (a real multi-instance story),
and 11 (migration/rollback discipline) — it makes them *demonstrable*, not
closed.

## Decision

Ship the artifacts that turn ADR-0025's design into something you can
actually run, and keep them honestly labelled as reference, not
production-blessed.

**1. A multi-stage `Dockerfile` for the HTTP MCP server.** A build stage with
the full toolchain runs the workspace build (`tsc -b`); a slim runtime stage
(`node:22-slim`, non-root user) copies only the built output and pruned
production dependencies. The image's entrypoint is the HTTP server
(`bin-http.ts`). A `.dockerignore` keeps `node_modules`, `.git`, and test
output out of the build context. The build is workspace-aware (npm
workspaces): dependencies are installed once at the root and the built
`@typesys/*` packages are resolved from the workspace, documented inline
because a naive per-package `COPY` breaks workspace symlinks.

**2. Health and readiness endpoints, as a prerequisite.** `createHttpApp`
gains `GET /healthz` (liveness — the process is up) and `GET /readyz`
(readiness — the registry store answers, and Redis, if configured, is
reachable). These are unauthenticated, side-effect-free, and carry no domain
data, so they leak nothing; they are what the container `HEALTHCHECK` and the
Kubernetes probes below target. Pulled into this ADR because there is no
point shipping a container an orchestrator can't gate traffic on.

**3. A `docker-compose.yml` that stands up the real topology.** Postgres,
Redis, a one-shot migration service that runs `migrate:postgres` (the
advisory-lock-safe runners from ADR-0025) to completion before the app
starts, N app replicas, and a reverse proxy (nginx) in front. This is the
ADR-0025 story end-to-end on one machine: several replicas, one Postgres, one
Redis, one rate-limit budget per identity — and it makes `npm run load-test`
runnable against a realistic layout instead of bare processes.

**4. Reference Kubernetes manifests (plain YAML, not a chart).** A
`Deployment` (N replicas), a `Service`, a migration `Job` (or
`initContainer`) that must succeed before rollout, a `ConfigMap` for
non-secret configuration, and a `Secret` *reference* for `DATABASE_URL` /
`REDIS_URL` / OIDC settings — env wired from the Secret, with a comment that
the values come from the cluster's secret store, never from the repo. Probes
point at `/healthz` and `/readyz`. Kept as flat manifests to stay readable and
tool-agnostic; Helm/Kustomize are noted as the packaging step a real
deployment would add.

**5. One documented environment surface.** A single table (in the deployment
how-to) of every environment variable the server reads — `PORT`,
`DATABASE_URL`, `REDIS_URL`, the OIDC issuer/audience/JWKS settings
(ADR-0018), the OpenTelemetry `OTEL_*` variables (ADR-0017), and the
resilience/concurrency knobs (ADR-0019/0026) — so the container, compose, and
k8s configs all reference the same contract.

Scope boundary, stated plainly: this ADR stops passing secrets as
checked-in plaintext and documents where they come from. It does **not**
solve secrets management, TLS termination, at-rest encryption, image
scanning, or base-image patching — those remain `PRODUCTION-READINESS.md`
items. The manifests are a correct, runnable starting point, not an
accredited one.

## Consequences

- The multi-replica system ADR-0025 describes becomes something a reviewer
  can `docker compose up` and watch: shared cache invalidation, one budget
  across replicas, migrations running exactly once.
- The load test and the multi-instance tests stop silently assuming a
  hand-built environment; the same compose topology backs them.
- Health/readiness endpoints are a small, permanent addition to the HTTP
  transport, useful well beyond containers.
- The artifacts are versioned with the code, so a change that alters the
  deploy contract (a new required env var, a new migration step) is caught in
  review, not in production.
- These are reference artifacts. Treating them as production-ready without an
  image-scanning, secret-management, and TLS story would be exactly the false
  confidence `PRODUCTION-READINESS.md` warns against; they are labelled
  accordingly.

## Alternatives Considered

- **A Helm chart or Kustomize base instead of flat manifests.** Deferred, not
  rejected: templating is valuable once there are environments to vary
  across, but it obscures the artifact for a first read. Flat YAML shows
  exactly what runs; a chart is the natural next step a deploying team adds.
- **Buildpacks / `ko` / `jib`** (no Dockerfile). Rejected: a multi-stage
  Dockerfile is transparent and universally understood, and the
  workspace-aware build is clearer written out than delegated to a builder's
  heuristics.
- **Distroless runtime base.** Considered and noted as a hardening step;
  `node:22-slim` is chosen first for debuggability (a shell in the image),
  with distroless as the follow-up once the image is otherwise settled.
- **A single all-in-one image bundling Postgres and Redis.** Rejected: it
  directly contradicts the shared-state design (ADR-0025) — the whole point
  is many app replicas against *one* Postgres and *one* Redis. Compose and
  k8s wire them as the separate services they must be.
- **Ship nothing; document how to build your own.** Rejected — that is the
  current state and the gap this ADR exists to close. A reference that runs
  is worth more than prose describing one that would.
