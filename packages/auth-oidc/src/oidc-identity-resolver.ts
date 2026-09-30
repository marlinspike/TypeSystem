import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Identity } from "@typesys/core";

export type IdentityResolver = (token: string | undefined | null) => Promise<Identity>;

export interface OidcIdentityResolverConfig {
  /** Expected `iss` claim. Also used to derive the default JWKS URL (`${issuer}/.well-known/jwks.json`). */
  issuer: string;
  /** Expected `aud` claim, if the IdP issues one. */
  audience?: string;
  /** Dot-separated claim path to read roles from, e.g. "realm_access.roles". Defaults to "roles". */
  rolesClaim?: string;
  /**
   * Dot-separated claim path to read the subject's classification clearance
   * from (ADR-0032), e.g. "clearance". Unset — or a claim that isn't a
   * string — maps no clearance, so the subject reads only unclassified data.
   */
  clearanceClaim?: string;
  /**
   * Override JWKS resolution — the real production default is a remote
   * fetch against the issuer's own JWKS endpoint; tests supply a
   * `createLocalJWKSet`-built one instead, exercising the identical
   * `jwtVerify` call with zero network calls (see ADR-0018).
   */
  jwks?: JWTVerifyGetKey;
  /**
   * On verification failure, resolve to an anonymous Identity (default,
   * `true`) rather than throwing. "Fail open to anonymous" — not to
   * unauthenticated access: an anonymous Identity still goes through the
   * exact same PolicyEngine check every other identity does, and is
   * denied unless a policy explicitly allows it.
   */
  failOpenToAnonymous?: boolean;
}

export function anonymousIdentity(): Identity {
  return { subjectId: "anonymous", roles: [], attributes: {} };
}

function readClaimPath(payload: JWTPayload, claimPath: string): unknown {
  return claimPath.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, payload);
}

function extractRoles(payload: JWTPayload, claimPath: string): string[] {
  const value = readClaimPath(payload, claimPath);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Real OIDC/JWT identity resolution (see ADR-0018) — verifies a bearer
 * token's signature and `iss`/`aud` claims via `jose`, then maps it onto
 * this project's `Identity` shape. Fails closed to an anonymous identity
 * by default: a bad token is "denied by policy," not a crash.
 */
export function createOidcIdentityResolver(config: OidcIdentityResolverConfig): IdentityResolver {
  const jwks = config.jwks ?? createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`));
  const rolesClaim = config.rolesClaim ?? "roles";
  const failOpen = config.failOpenToAnonymous ?? true;

  return async (token) => {
    if (!token) return anonymousIdentity();

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience
      });

      const scope = payload.scope;
      const clearance = config.clearanceClaim ? readClaimPath(payload, config.clearanceClaim) : undefined;
      return {
        subjectId: typeof payload.sub === "string" ? payload.sub : "unknown",
        roles: extractRoles(payload, rolesClaim),
        attributes: payload,
        ...(typeof scope === "string" ? { tokenScopes: scope.split(" ").filter(Boolean) } : {}),
        ...(typeof clearance === "string" ? { clearance } : {})
      };
    } catch (err) {
      if (!failOpen) throw err;
      return anonymousIdentity();
    }
  };
}
