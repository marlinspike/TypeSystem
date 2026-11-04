# Pressure test: easy to deploy and use (ADR-0116 to ADR-0121), 2026-11-04

An adversarial pass over the branch before it was pushed: the sign-in path
(forged and foreign tokens, a provider that is down or lying, headers a caller
controls), what leaves the process (logs, spans, metrics), the files
`deploy package` writes, and the image. Each finding was reproduced before it
was fixed, and each fix has a test that fails without it.

## Fixed

**F1 (Medium). A forged token header read as the identity provider being
down.** A token whose header names an `alg` no key set can hold (`HS256`,
`RSA-OAEP`, a made-up one) made `jose` throw `ERR_JOSE_NOT_SUPPORTED` before
any key lookup. The resolver called every error that was not "no matching key"
a provider failure, so such a token got `503` and an "Identity provider
unavailable" error in the server's log, once per request: anyone could fill the
log with a false outage and page whoever watches for it. Reproduced with four
forged headers; three gave `IdentityProviderUnavailableError`. Now only fetch
failures are the provider's; the header faults are the token's (`401
invalid_token`). Test: `calls a forged header a bad token, not the provider
down` in `packages/auth-oidc/test`. Mutation `oidc.forged-alg-is-provider-down`.

**F2 (Medium). The runtime's metrics never reached the collector a deployment
names.** `@typesys/core` took its meter when it was imported, before the
server registered the deployment's provider, and OpenTelemetry's API has no
proxy meter (it has one for tracers), so every counter and histogram stayed a
no-op. Only traces were tested. The instruments are now made again whenever
the global provider changes, and the telemetry test asserts that
`/v1/metrics` carries `typesys.operation.duration` and
`typesys.policy.decisions` with no object or subject id. Mutation
`telemetry.metrics-bound-at-import`.

**F3 (Low). Every start paid for the OpenTelemetry SDK.** Importing the
server loaded the SDK and both exporters (about 120 ms) whether or not the
deployment declares telemetry. They are now loaded only when it does (27 ms
for the module).

## Kept, with reasons

**K1 (Low). A promoted role map is a placeholder.** `deploy promote` maps
each role to a provider value of the same name (`"reader": ["reader"]`), so a
deployment served without editing it grants `reader` to anyone the provider
puts in a group called `reader`. It is printed as the step to do, and the
names are the policies' own, but nothing refuses to serve it unedited. A check
that refuses an identity map would also refuse providers whose group names are
the roles.

**K2 (Low). Hosted application ports do not challenge or log.** Applications
a deployment hosts (ADR-0108) run on ports of their own, with the same
resolver: a bad token is refused and a provider that is down is a 503, but a
request with no token is anonymous (as before) and is not in the request log.
Their clients are browsers with their own sign-in.

**K3 (Low). A path no route matches is logged as sent.** The request log takes
ids out of every route the API serves and drops every query, but a request for
an unknown path keeps segments up to 64 characters, so a caller can put its
own text in the log. It is the caller's own input, never a value the server
read.

**K4 (Low). The metadata for `/mcp` names the origin as the resource.** Both
metadata paths answer with the server's origin. RFC 9728 reads as if the
path-suffixed document should name `.../mcp`; the MCP SDK accepts the origin
(its `auth()` client is tested against it), and one resource for MCP and the
API lets one audience cover both.

**K5 (Low). The issuer must match its discovery document exactly.** A
deployment that writes Auth0's issuer without its trailing slash gets a 503
saying the document is for another issuer. The message names both values.

**K6 (Low). The library still fails open by default.**
`createOidcIdentityResolver` keeps `failOpenToAnonymous: true` as its default
for existing embedders; the generic host sets it to `false`, so a deployment
never treats a bad token or an unreachable provider as anonymous.

## Checked and sound

- A token for another audience, an expired one, one signed by another key,
  and one with an unknown `kid` are each `401 invalid_token`; no token is
  `401` with the challenge on `/mcp` (JSON-RPC `-32001`) and `/api`.
- A discovery document that names another issuer is refused; a failed
  discovery is retried on the next token, not remembered, and concurrent
  tokens share one fetch.
- The challenge and metadata are built from `Host` only after the host guard
  accepted it, and a derived answer is `Cache-Control: no-store`.
- `X-Request-Id` is echoed only when it matches `[A-Za-z0-9._-]{1,64}`, so a
  header cannot be split.
- `migrate` and `deploy build` redact connection strings from database errors.
- The packaged deployment builds to the same id as the original; the signing
  key is never an environment variable in the Kubernetes files, and the
  Compose and Kubernetes secrets directories are git-ignored.
- The pruned image tree has every OpenTelemetry and YAML dependency the server
  loads, and starts.
