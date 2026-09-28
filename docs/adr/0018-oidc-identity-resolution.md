# 0018. Real OIDC/JWT Identity Resolution

## Status

Accepted

## Context

ADR-0009 and ADR-0012 deliberately shipped a static bearer-token map
(`demo-maintainer-token` → a canned `Identity`) instead of real OIDC/JWT
verification, reasoning that building real token verification with no
live IdP to verify against would be exactly the over-engineering the
mission brief's non-goals warn against. That reasoning was correct for a
demo whose whole purpose was proving the *runtime's* governance boundary
works — it was never a claim that real auth was hard, only that it was
premature.

It's no longer premature. "Robust and useful anywhere" means a real
deployment must be able to plug in real identity verification without
forking this codebase, and — the harder requirement — that verification
logic must be provably correct without requiring a live production IdP
in this repository's own test environment.

## Decision

### A new package, `@typesys/auth-oidc`, built on `jose`

`jose` (not a hand-rolled JWT/JWK implementation — "prefer established
standards," and this is exactly the kind of code that must not be
hand-rolled) provides `jwtVerify`, `createRemoteJWKSet`, and
`createLocalJWKSet`. `createOidcIdentityResolver(config)` returns an
`IdentityResolver` — `(token) => Promise<Identity>` — that:

- Fetches (and caches) the issuer's JWKS remotely by default
  (`createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"))`), or
  accepts a caller-supplied `jwks` (a `createLocalJWKSet`-built one, for
  tests — see Testing below).
- Verifies signature, `iss`, and (if configured) `aud` via `jwtVerify`.
  Passing `issuer` to `jwtVerify` **is** RFC 9207's mitigation — the
  token's claimed issuer is checked against the expected one explicitly,
  not inferred from which endpoint happened to hand it back.
- Maps `sub` → `Identity.subjectId`, a configurable claim path
  (`rolesClaim`, default `"roles"`) → `Identity.roles`, the full payload
  → `Identity.attributes`, and a space-separated `scope` claim (RFC 6749)
  → `Identity.tokenScopes` — the field ADR-0009 reserved for RFC 9396 rich
  authorization requests. This resolver reads whatever scopes an IdP
  issued; it does not implement RAR's *request* side, which is the
  client's and IdP's problem, not the resource server's.
- **Fails closed to an anonymous `Identity`** on any verification
  failure by default (`failOpenToAnonymous: true` — the name describes
  the failure's *safety direction*: open to treating the caller as
  anonymous, not open to unauthenticated access). A malformed, expired,
  or wrong-issuer token becomes "no roles, denied by the policy engine
  downstream," not a 500 — consistent with ADR-0012's stateless, re-check-
  every-call design. Set `failOpenToAnonymous: false` to throw instead,
  if an application wants to surface verification failures distinctly
  from "this identity has no permissions."

### The demo's static token map is not replaced — it's now one configuration away from real auth

`packages/mcp-server/src/auth.ts` keeps its zero-config default
(the static demo tokens `npm run smoke:mcp` and the web demo depend on)
but now accepts an `IdentityResolver` injected into `createServer()`,
threaded through to `registerResourceHandlers`/`registerToolHandlers` as
a parameter — never mutable module-level state, so nothing about
identity resolution is shared/leaked across test files or requests.
Wiring a real deployment to `@typesys/auth-oidc` instead of the demo
map is exactly:

```ts
const identityResolver = createOidcIdentityResolver({ issuer: "https://my-idp.example.com" });
const { server } = await createServer(testbed, identityResolver);
```

Nothing about `resources.ts`/`tools.ts`, the runtime, or the policy
engine changes — identity resolution was already a narrow seam
(ADR-0012's `resolveIdentity`), this just makes it a real, swappable
function argument instead of a fixed demo implementation.

### Testing without a live IdP, by testing the actual verification code path

`jose`'s `jwtVerify` does not know or care whether its `JWTVerifyGetKey`
came from `createRemoteJWKSet` (a real HTTPS fetch) or
`createLocalJWKSet` (an in-memory JWK set) — it's the same function
either way. Tests generate a real RSA key pair
(`jose`'s `generateKeyPair`), sign a real JWT with the private key
(`SignJWT`), verify it with `createLocalJWKSet` wrapping the public key,
and assert on the resulting `Identity` — genuine cryptographic
verification, zero network calls, zero live IdP required. This is the
same testing strategy ADR-0015 used for Postgres binding rehydration:
test the real mechanism, fake only the one thing (a live external
service) that can't reasonably exist in CI.

## Consequences

- `Identity.attributes` now potentially contains arbitrary JWT claims
  from a real IdP, not just the small canned shape the demo identities
  used — any policy rule reading `subject.attributes` should treat
  unknown/missing claims defensively (`attributes.foo ?? []`, not
  `attributes.foo.includes(...)` unguarded).
- `@typesys/auth-oidc` depends on `jose` and nothing else from this
  project's own packages except `@typesys/core` (for the `Identity`
  type) — it can be used by any consumer (MCP server, demo web app, a
  future HTTP-transport MCP server) without pulling in MCP- or
  Express-specific code.
- A production deployment still owns real IdP configuration (issuer URL,
  audience, role-claim shape) — this ADR provides the verification
  mechanism, not a specific IdP integration.

## Alternatives Considered

- **Hand-rolling JWT verification** (base64-decode + signature check):
  rejected outright — this is precisely the category of security-critical
  code the "prefer established standards" principle exists to keep
  projects from reinventing badly.
- **`jsonwebtoken` / `jwks-rsa`** (the older, more established Node JWT
  ecosystem): considered — `jose` was chosen instead for native ESM
  support (no CJS interop friction, a real recurring cost in this
  codebase — see the `ajv`/`js-yaml` import gotchas in earlier ADRs),
  active maintenance, and because it already ships exactly the
  local-vs-remote JWKS abstraction this design needed for testability
  without inventing one.
- **Requiring a live test IdP (e.g., a local Keycloak container) for
  real verification**: rejected for this pass — heavier CI/dev
  infrastructure for a marginal increase in realism over signing real
  JWTs against a real (locally generated) key pair, which already
  exercises the identical `jwtVerify` code path production traffic hits.
  Worth reconsidering if a future need genuinely requires testing
  IdP-specific behavior (token refresh flows, specific claim quirks of
  one vendor), not just JWT verification itself.
- **Making identity resolution mutable global state** (a
  `setIdentityResolver()` call swapping a module-level default):
  rejected — it would make which resolver is active depend on
  import/call order and leak across anything sharing the module registry
  (a real risk in a single test process running many files). A parameter
  threaded through `createServer()` has none of that risk and costs
  nothing.
