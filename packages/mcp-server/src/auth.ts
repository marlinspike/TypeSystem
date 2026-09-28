import type { Identity } from "@typesys/core";
import { demoIdentities } from "@typesys/domain-airforce";

const DEMO_TOKENS: Record<string, Identity> = {
  "demo-maintainer-token": demoIdentities.maintainer,
  "demo-viewer-token": demoIdentities.viewer
};

/**
 * Resolves a bearer token into an `Identity`, fresh on every single
 * resource read or tool call — MCP (2026-07-28) is stateless, so identity
 * must never be cached on a connection/session object (see ADR-0012).
 *
 * Not a fixed dependency of this package: `createServer()` accepts one of
 * these as a parameter, defaulting to `resolveDemoIdentity` below (the
 * static token map `npm run smoke:mcp` and the web demo depend on) —
 * threaded through as a function argument, never mutable module state,
 * so nothing about which resolver is active can leak across requests or
 * test files. A real deployment passes
 * `@typesys/auth-oidc`'s `createOidcIdentityResolver(...)` instead — same
 * shape, real signature/issuer/audience verification (see ADR-0018).
 */
export type IdentityResolver = (token: string | undefined | null) => Promise<Identity>;

export async function resolveDemoIdentity(token: string | undefined | null): Promise<Identity> {
  if (!token) return demoIdentities.anonymous;
  return DEMO_TOKENS[token] ?? demoIdentities.anonymous;
}
