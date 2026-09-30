# 0050. The MCP Server Serves Any Registry

## Status

Accepted — implemented in `@typesys/mcp-server` (`server.ts`,
`http-transport.ts`, `resources.ts`, `auth.ts`, `package.json`),
`@typesys/domain-airforce` (`resolveDemoIdentity`), and `@typesys/demo-web`
(the demo's stdio and HTTP entry points). Amends ADR-0012, ADR-0018 and
ADR-0021, which fixed the signatures of `createServer()` and
`createHttpApp()` and gave the former a zero-config default identity
resolver. Proven by:

- `packages/mcp-server/test/generic-backend.test.ts` — `createServer` and
  `createHttpApp` over the hospital domain, which shares nothing with the
  airforce demo: its Types are listed, nothing of airforce is, identity
  comes only from the resolver given (header over in-band token), readiness
  asks the registry given, and a missing resolver or backend refuses to
  build. A structural guard fails the suite if a `src` file imports a
  domain or the package depends on one.
- The existing contract, classification, telemetry and health suites, now
  handed a backend and a resolver explicitly, and both smoke scripts
  (`npm run smoke:mcp`, `npm run smoke:mcp-http`) against the relocated demo
  entry points.

Mutation-checked (10 mutations): `createServer` falling back to an anonymous
identity, accepting any backend, `createHttpApp` falling back to a built-in
resolver, the in-band token outranking the `Authorization` header, a
hardcoded sample object listed again, readiness no longer asking the given
registry, the package depending on a domain (in `package.json` and in a
source file), the announced name and version ignored, and the demo token
lookup walking the prototype chain — each fails exactly one test.

## Context

ADR-0012 and ADR-0013 say the MCP layer is generic over whatever the
registry holds, and for the two handler functions, `registerResourceHandlers`
and `registerToolHandlers`, that was true: the hospital domain's tests run
them unmodified. The entry points built on them were not:

- `createServer(testbed?: AirforceTestbed, resolver = resolveDemoIdentity)`
  and `createHttpApp({ testbed?: AirforceTestbed })` were typed to the
  airforce demo's bundle, and built it when none was passed.
- `auth.ts` imported the airforce domain's identities; the package depended
  on `@typesys/domain-airforce` (and through it on `adapter-mock-rest`).
- `resources.ts` listed a hardcoded `airforce.Aircraft/AF86-0147` resource
  for every registry. Reading it from any other domain's server fails with
  `Unknown type "airforce.Aircraft"`.
- The package's two `bin` entries ran only the demo.

So a project building on TypeS could not use `createServer()` or
`createHttpApp()` at all. `docs/how-to/start-a-project.md` builds its server
from the two handler functions instead, installs the airforce domain as a
dependency to do so, and lists the stray resource as a known issue.

The zero-config default identity resolver, which ADR-0018 kept on purpose
for the demo, is the sharpest part of the tie. A production server that
forgot to pass a resolver would honour `demo-maintainer-token`, a constant
in the source, as a maintainer.

## Decision

**1. `createServer(backend, resolveIdentity, info?)`.** `backend` is
`McpBackend`: `{ registry, runtime }`. Anything `buildRuntime` returns
satisfies it, and any extra fields (the airforce testbed's adapters, say)
are passed through. The function is synchronous, since there is nothing
left to build, and returns `{ ...backend, server }`. `info` is the
`{ name, version }` the server announces, defaulting to `typesys-mcp-server`
and `0.1.0`.

**2. `createHttpApp({ backend, identityResolver, serverInfo? })`** and
`startHttpServer(port, options)` take the same, both required. The backend
is built by the caller before the app is, so it is shared by every request
as before (the audit log and cache still survive between calls), while the
MCP `Server` and transport stay per request (ADR-0021). `/readyz` asks the
registry it was given.

**3. No default identity.** Omitting the resolver or the backend throws a
`TypeError` at construction, also for a JavaScript caller that bypasses the
types. A server that cannot say who is asking should not start, and a
generic package has no domain whose identities it could assume.

**4. `resources/list` lists the Types and nothing else.** There is no
object resource to list for a registry the package knows nothing about.
Objects are found with the `query` tool and read by URI.

**5. The package depends on no domain.** `@typesys/domain-airforce` moves
to `devDependencies` (its tests run against the demo), and no file in `src`
imports a domain. `resolveDemoIdentity`, the demo's token map, becomes an
export of `@typesys/domain-airforce` beside the `demoIdentities` it maps to.
A test fails the build if a domain import or dependency returns.

**6. The demo's entry points live with the demo.** `@typesys/mcp-server` no
longer ships a `bin`. The stdio and HTTP entry points over the airforce
testbed move to `@typesys/demo-web` (private, never published), and
`npm run mcp:http`, the Dockerfile, both smoke scripts and the load-test
replica point at them. A project runs its own entry points, as
`docs/how-to/start-a-project.md` shows.

## Consequences

- A project's MCP server is `createServer(await getTypeSys(), resolveIdentity)`.
  The start-a-project guide drops the workaround, the known issue, and the
  instruction to install the airforce domain.
- **Breaking for every caller of `createServer()` or `createHttpApp()`:**
  the repository's tests, scripts and demo, and `@typesys/auth-oidc`'s
  README. Nothing is published; the changesets are a minor bump of
  `@typesys/mcp-server` and `@typesys/domain-airforce`.
- A published `@typesys/mcp-server` has no runnable binary. Someone who
  wants the demo server runs it from the repository.
- The hospital neutrality tests used to prove the handlers generic; the
  generic-backend tests now prove the entry points are too.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **The resolver is the whole of authentication.** `createHttpApp` trusts
  whatever identity `identityResolver` returns, so a resolver that maps
  every token to a privileged identity gives it to everyone. It is
  deployment code, and part of the trusted computing base (ADR-0047).
- **Nothing here secures the transport.** TLS, CORS, and an authorization
  server belong in front of the HTTP server, as ADR-0021 says.
- **`info.name` and `info.version` are sent to every client.** They are for
  identifying the server, not for anything sensitive.

## Alternatives Considered

- **Widen the type and keep the rest.** Accepting any backend where
  `AirforceTestbed` was accepted removes the type error and leaves the
  demo default, the package dependency, the hardcoded resource, and the
  airforce `bin`: the tie.
- **Keep the demo identity resolver as the default.** One fewer argument in
  the demo; in production, hardcoded tokens honoured by a forgetful
  deployment. One line of boilerplate is cheaper.
- **Default to an anonymous resolver.** Fails closed, but only at request
  time, as every call being denied, far from its cause.
- **Keep the `bin`s, with the airforce domain an optional peer dependency.**
  A published binary that fails to start unless a peer is installed.
- **Put the demo entry points in `@typesys/domain-airforce`.** That would
  pull Express and the MCP SDK into a domain package, the wrong way round.
- **A generic `typesys-mcp-server --backend ./module.js`.** Attractive, and
  new surface: how a module exports a backend and a resolver, how it is
  configured and secured. It deserves its own decision, and removing the tie
  does not need it.
