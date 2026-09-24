import type { Identity } from "@typesys/core";
import { demoIdentities } from "@typesys/domain-airforce";

const DEMO_TOKENS: Record<string, Identity> = {
  "demo-maintainer-token": demoIdentities.maintainer,
  "demo-viewer-token": demoIdentities.viewer
};

/**
 * Resolves an Identity fresh from a bearer token on every single resource
 * read or tool call — MCP (2026-07-28) is stateless, so identity must
 * never be cached on a connection/session object (see ADR-0012). This
 * demo accepts a small set of static bearer tokens for canned identities.
 * The production path is a real OIDC-issued JWT verified against the
 * issuer's JWKS, with RFC 9207 issuer validation and RFC 9396 rich
 * authorization requests for fine-grained agent scoping — same
 * Identity/PolicyEngine interfaces, only the token-verification
 * implementation differs. Building that here, with no real IdP to verify
 * against, would be exactly the over-engineering the project's non-goals
 * warn against.
 */
export function resolveIdentity(token: string | undefined | null): Identity {
  if (!token) return demoIdentities.anonymous;
  return DEMO_TOKENS[token] ?? demoIdentities.anonymous;
}
