---
"@typesys/mcp-server": minor
---

Deployment artifacts (ADR-0029): the HTTP transport gains unauthenticated `GET /healthz` (liveness) and `GET /readyz` (readiness — a cheap registry read that returns 503 when the store is unreachable) for orchestrator probes. Ships alongside a multi-stage `Dockerfile`, a `docker-compose.yml` (Postgres + Redis + one-shot migration + N app replicas + nginx), reference Kubernetes manifests (`deploy/k8s/`), and a deploy how-to — all reference artifacts, correct and runnable but not production-hardened.
