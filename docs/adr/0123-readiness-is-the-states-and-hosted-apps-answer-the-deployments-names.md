# 0123. Readiness Is the State's, and Hosted Applications Answer the Deployment's Names

## Status

Accepted (2026-11-11). Implemented in `packages/host/src/state.ts`,
`packages/mcp-server/src/http-transport.ts`, `packages/host/src/serve.ts` and
`packages/app/src/server.ts`. Proven by `packages/host/test/sources.test.ts`,
`packages/mcp-server/test/http-health.test.ts` and
`packages/app/test/server.test.ts`.

## Context

The 2026-11-04 pressure test found three faults in how a deployment is served:

- `/readyz` pinged every pool, the sources' included. One source with a wrong
  password took every replica out of rotation, although the runtime answers
  503 for that source's Types alone (M3).
- `/readyz` returned the driver's error text, which names roles and hosts, with
  no token (L2). `/version` returned the audit chain id with no token.
- An application the deployment hosts was served by `applicationApp` without
  the deployment's `allowedHosts` or sign-in. Behind a real host name it
  answered every request 403 (M1).

## Decision

- **Readiness is the state's.** It covers the audit, workflow, cache and rate
  limit stores that were open before any source. A source that is down answers
  503 for its own Types.
- **A failed readiness check says only `{"status":"not_ready"}`.** The cause is
  logged on the server.
- **`/version` no longer names the audit chain.** The server's start-up line
  does.
- **A hosted application is guarded like the main server.** It gets the
  deployment's allowed host names and the same sign-in, and challenges a
  request with no token with the same RFC 9728 metadata URL.

## Consequences

A source outage no longer looks like a server outage to a load balancer. An
operator reads why a replica is not ready in its log, not from an unauthenticated
endpoint.
