# 0116. Clients Sign In Through the Deployment's Provider

## Status

Accepted (2026-11-04). Implemented in `packages/http/src/sign-in.ts`,
`packages/http/src/api.ts`, `packages/mcp-server/src/http-transport.ts`,
`packages/auth-oidc/src/oidc-identity-resolver.ts`, and the `oidc` identity
of `packages/host/src/deployment.ts` and `packages/host/src/host.ts`. Proven by
`packages/host/test/sign-in.test.ts` (including the MCP SDK's own `auth()`
client finding the provider from a 401) and `packages/auth-oidc/test`.

## Context

The easy-to-deploy assessment of main at 66cba7c
(`/mnt/project-files/next/easy-to-deploy-and-use-2026-11-04.md`) found that no
one could sign in to a shared server:

- An MCP `initialize` without a token was answered `200` as anonymous. The MCP
  authorization specification (2025-06-18) asks a server to answer `401` with
  `WWW-Authenticate: Bearer resource_metadata="..."` and publish OAuth
  Protected Resource Metadata (RFC 9728) naming its authorization server, which
  is how a client such as Claude Code or the MCP SDK finds where to sign in.
- `identity.audience` was optional, so outside a demo any token the provider
  issued for any other application was accepted.
- The key set defaulted to `${issuer}/.well-known/jwks.json`, which is wrong
  for Microsoft Entra ID, Okta, Google and Keycloak; none of them was found
  through OpenID Connect discovery.
- Roles came from a claim as is. A provider's group names (often object ids)
  could not be mapped to a deployment's roles.

## Decision

A deployment whose identity is `oidc` asks clients to sign in:

- It serves `/.well-known/oauth-protected-resource` (and the same document at
  `.../mcp`) naming `identity.issuer` as its authorization server and
  `identity.resource` (default: the origin of each request) as the resource.
- A request with no token gets `401` and the challenge above, on `/mcp` (with a
  JSON-RPC error) and on `/api`. A token that does not verify gets the same
  challenge with `error="invalid_token"`. A provider that cannot be reached
  answers `503`, never anonymous. `identity.allowAnonymous: true` keeps the old
  behaviour where a deployment wants it.
- `identity.audience` is required unless the deployment is a demo.
- Keys come from the provider's discovery document (`jwks_uri`), whose `issuer`
  must equal the configured one; `identity.jwksUrl` overrides it.
- `identity.roleMap` maps the provider's names to roles. When it is given, a
  value it does not list grants nothing.

## Consequences

An MCP client pointed at `https://<server>/mcp` discovers the provider and
signs in with no configuration beyond the deployment. Every existing `oidc`
deployment that is not a demo must add an audience, and `typesys deploy build`
says so. The server does not issue tokens and does not register clients: the
provider does (dynamic client registration, where clients need it, is the
provider's setting).
