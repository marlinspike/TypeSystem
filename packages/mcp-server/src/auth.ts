import type { Identity } from "@typesys/core";

/**
 * Resolves a bearer token into an `Identity`, fresh on every single
 * resource read or tool call. The server is stateless by design, so
 * identity must never be cached on a connection/session object (see
 * ADR-0012). That is this codebase's rule, not a claim about a spec
 * revision: the pinned SDK negotiates MCP 2025-11-25 at most.
 *
 * This is the whole of a server's authentication, and it is always supplied
 * by the caller (ADR-0050): `createServer()` and `createHttpApp()` take one
 * as a required argument and assume none of their own, threaded through as
 * a function argument, never mutable module state, so nothing about which
 * resolver is active can leak across requests or test files. A real
 * deployment passes `@typesys/auth-oidc`'s `createOidcIdentityResolver(...)`
 * — real signature/issuer/audience verification (see ADR-0018). The demo's
 * static token map is `resolveDemoIdentity` in `@typesys/domain-airforce`.
 */
export type IdentityResolver = (token: string | undefined | null) => Promise<Identity>;
