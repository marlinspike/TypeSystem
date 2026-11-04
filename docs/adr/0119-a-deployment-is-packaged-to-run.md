# 0119. A Deployment Is Packaged to Run

## Status

Accepted (2026-11-04). Implemented in `packages/host/src/package.ts`,
`typesys deploy package` in `packages/host/src/cli.ts`, and
`secretFromEnvironment` in `packages/host/src/host.ts`. Proven by
`packages/host/test/package.test.ts` (including `docker compose config` on the
output and the packaged deployment building to the same id).

## Context

`docker-compose.yml` and `deploy/k8s/typesys.yaml` served the airforce
demonstration only. Running one's own deployment meant writing Compose or
Kubernetes files by hand, and the reference ConfigMap left out the packs a
deployment from `init` needs. Secrets could only be environment variables,
which Compose secrets and Kubernetes secret volumes do not produce.

## Decision

`typesys deploy package <deployment.json> --target compose|k8s` writes a
directory that runs the deployment on the published image:

- The deployment and its pack archives, copied byte for byte (the build id is
  unchanged), and the audit signing key when it is beside the deployment.
- For Compose: a state database (unless `--external-state`), a `migrate`
  one-shot the app waits on, the app with the key as a Compose secret, an
  `audit-verify` service under the `ops` profile, and `.env.example` naming
  every secret and setting.
- For Kubernetes: a Deployment whose init container migrates, probes, a
  restricted security context, resources, a Service, a PodDisruptionBudget,
  CronJobs for `audit verify` and (with `retainDays`) `audit prune`, and a
  `kustomization.yaml` whose generators roll the pods when the deployment or
  its secrets change. The signing key is its own Secret, mounted as a file.

Any secret `NAME` may be given as a file through `NAME_FILE`; a trailing
newline is dropped, and an unreadable file stops the server with its name.

## Consequences

The path from a promoted deployment to a running one is: fill `.env` (or
`secrets.env`), `docker compose up -d` (or `kubectl apply -k`). The files are a
starting point a team owns: TLS, ingress, scaling and a managed database are
theirs to add.
