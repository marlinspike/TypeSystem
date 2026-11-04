# 0112. A Deployment Is Developed Against a Running Server

## Status

Accepted (2026-11-03). Implemented in `packages/host/src/dev.ts`
(`startDev`, `devCommand`, `welcome`), `packages/host/src/serve.ts` (`GET /`)
and `packages/http/src/api.ts` (`GET /api`). Proven by
`packages/host/test/usability.test.ts`.

## Context

Serving a deployment meant `node packages/host/dist/serve.js <file>`, after
which a newcomer had to find the tokens in the JSON, guess the query shape,
and restart by hand after each edit. `GET /` answered with Express's
`Cannot GET /` page and `GET /api` with a 404.

## Decision

`typesys dev <deployment.json>` serves the deployment exactly as the
generic server does, then prints each persona with its token and roles, a
first `curl` on a Type of the deployment's own model, and the
`claude mcp add --transport http ...` line that connects Claude Code as
that persona. It runs `<name>.tests.json` beside the deployment when there
is one. It watches the deployment, its packs and its tests; on a change it
builds the new deployment, with its own state, and checks its sources
first, and only if that succeeds replaces what is serving, on the same
port. It listens on 127.0.0.1, so a drafted deployment's fixed tokens
answer only callers on that machine; `--host` changes that, for a
deployment whose identity is not fixed tokens. A change that
does not build is reported and the last build that did keeps serving.

`GET /` answers with the deployment's name, build, and where MCP, the API,
OpenAPI, the version and the health checks are. `GET /api` lists the
routes, with the shape of a query. Neither needs a token, and neither says
anything about the model: `/model` and `/openapi.json` are still decided
per caller.

## Consequences

This is restart on change for one developer's machine; production keeps
restarting by rollout, as decided on 2026-10-31. `--once` serves without
watching. Hosted applications are served too, on their declared ports.
