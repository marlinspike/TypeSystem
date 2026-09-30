# @typesys/auth-oidc

A real OIDC/JWT `IdentityResolver` — the production counterpart to
`@typesys/mcp-server`'s static demo-token map. Verifies a bearer token's
signature, issuer (RFC 9207), audience, and expiry against a JWKS
endpoint using [`jose`](https://github.com/panva/jose), then maps its
claims onto an `Identity`. See
[ADR-0018](../../docs/adr/0018-oidc-identity-resolution.md).

## Use it

```ts
import { createOidcIdentityResolver } from "@typesys/auth-oidc";
import { createServer } from "@typesys/mcp-server";

const resolveIdentity = createOidcIdentityResolver({
  issuer: "https://your-idp.example.com",
  audience: "typesys-mcp"
});

// `backend` is what `buildRuntime` returns: your registry and runtime.
const { server } = createServer(backend, resolveIdentity);
```

Same `IdentityResolver` shape (`(token) => Promise<Identity>`) as the
demo's resolver — nothing else about `mcp-server` changes. It is the only
thing that decides who is asking: the server assumes no identity of its own. Anywhere else
in the codebase that threads an `IdentityResolver` as a parameter
(never mutable module state, see ADR-0018) can take this one instead.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `issuer` | *(required)* | Checked against the token's `iss` claim (RFC 9207). |
| `audience` | *(none)* | Checked against `aud` when set. |
| `jwks` | remote JWKS at `${issuer}/.well-known/jwks.json` | Pass a `createLocalJWKSet(...)` result to test without a live IdP. |
| `rolesClaim` | `"roles"` | Dot-path into the payload, e.g. `"realm_access.roles"` for Keycloak. |
| `clearanceClaim` | *(none)* | Dot-path to a string claim holding the subject's classification clearance ([ADR-0032](../../docs/adr/0032-data-classification-enforcement.md)). Unset, no clearance is mapped and the subject reads only unclassified data. |
| `failOpenToAnonymous` | `true` | On any verification failure (bad signature, wrong issuer/audience, expired), resolve to the anonymous identity rather than throwing — matching the rest of the runtime's fail-closed-to-deny-by-policy model rather than a hard 401. Set `false` to throw instead. |

`scope` (RFC 9396), when present as a space-delimited string claim, is
split onto `identity.tokenScopes`.

## Verify it

```bash
npm test --workspace=@typesys/auth-oidc
```

8 tests, all against a locally generated RS256 key pair via
`generateKeyPair`/`SignJWT`/`createLocalJWKSet` — the identical
`jwtVerify` code path a remote-JWKS production config hits, with zero
network calls. Covers: anonymous-for-no-token, sub/roles/scope mapping,
nested `rolesClaim` paths, and fail-closed behavior on wrong issuer,
wrong audience, expired tokens, and a forged signature from a different
key entirely.
