# 0120. One Published Image Runs Every Deployment

## Status

Accepted (2026-11-04). Implemented in `Dockerfile`,
`.github/workflows/image.yml`, `packages/host/src/serve.ts`,
`docker-compose.yml` and `deploy/k8s/typesys.yaml`. Proven by
`packages/host/test/image.test.ts`.

## Context

There was no published image. Building the one in the repository failed:
`npm run build` reads `scripts/build-clients.ts`, which the Dockerfile did not
copy. Once built, its default command hung: `serve.js` awaited its own
`main()` at the top level, and the airforce extension imports `@typesys/host`,
so loading it waited on a module that was waiting on it.

## Decision

- The Dockerfile copies what the build reads, builds, prunes to production
  dependencies, removes sources and tests, and runs as `node` on code owned by
  root, with OCI labels and a health check. `serve.js` starts with
  `main().catch(...)` instead of a top-level `await`.
- The `Image` workflow builds it, checks that it serves the airforce
  demonstration and runs `migrate`, and publishes
  `ghcr.io/<owner>/typesystem:<version>` and `:sha-<commit>` (and `:latest`
  when asked). It is started by hand only (`workflow_dispatch`): never on a
  pull request, a push or a schedule.
- The reference Compose and Kubernetes files migrate through the deployment
  (ADR-0117) instead of `migrate:postgres`.

## Consequences

`docker run -p 3939:3939 ghcr.io/marlinspike/typesystem:<version>` serves the
demonstration, and the same image serves any deployment mounted into it. A
maintainer publishes a version by starting the workflow, and makes the GHCR
package public once.
