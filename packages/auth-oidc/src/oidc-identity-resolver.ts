import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { IdentityProviderUnavailableError, type Identity, type IdentityResolver } from "@typesys/core";

export type { IdentityResolver } from "@typesys/core";

export interface OidcIdentityResolverConfig {
  /** Expected `iss` claim, exactly as the provider writes it (some end in `/`). Where its discovery document is found (ADR-0116). */
  issuer: string;
  /** Expected `aud` claim. A deployment that is not a demo must set it (ADR-0116): without it, a token the provider issued for any other application is accepted. */
  audience?: string;
  /** Dot-separated claim path to read roles from, e.g. "realm_access.roles". Defaults to "roles". */
  rolesClaim?: string;
  /**
   * The provider's names for groups or roles → the deployment's roles
   * (ADR-0116). When given, only the values it names grant roles: a claim
   * value it does not list grants nothing, so a new group in the provider
   * grants no access until it is mapped here.
   */
  roleMap?: Readonly<Record<string, readonly string[]>>;
  /**
   * Dot-separated claim path to read the subject's classification clearance
   * from (ADR-0032), e.g. "clearance". Unset — or a claim that isn't a
   * string — maps no clearance, so the subject reads only unclassified data.
   */
  clearanceClaim?: string;
  /**
   * The provider's signing keys. Default: the `jwks_uri` of its OpenID
   * Connect discovery document (`<issuer>/.well-known/openid-configuration`),
   * fetched on the first token and kept (ADR-0116). `jwksUrl` names them
   * directly instead; tests supply a `createLocalJWKSet`-built one,
   * exercising the identical `jwtVerify` call with zero network calls
   * (ADR-0018).
   */
  jwks?: JWTVerifyGetKey;
  /** The provider's key set URL, when its discovery document should not be used. */
  jwksUrl?: string;
  /** How discovery and keys are fetched. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * On verification failure, resolve to an anonymous Identity (default,
   * `true`) rather than throwing. "Fail open to anonymous" — not to
   * unauthenticated access: an anonymous Identity still goes through the
   * exact same PolicyEngine check every other identity does, and is
   * denied unless a policy explicitly allows it. With `false`, a token
   * that does not verify throws, and a provider that cannot be reached
   * throws `IdentityProviderUnavailableError`, so a server can answer 401
   * and 503 (ADR-0116).
   */
  failOpenToAnonymous?: boolean;
}

export function anonymousIdentity(): Identity {
  return { subjectId: "anonymous", roles: [], attributes: {} };
}

function readClaimPath(payload: JWTPayload, claimPath: string): unknown {
  return claimPath.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && Object.hasOwn(acc as Record<string, unknown>, key)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, payload);
}

function claimValues(payload: JWTPayload, claimPath: string): string[] {
  const value = readClaimPath(payload, claimPath);
  // Some providers send a single role or group as a string rather than a list of one.
  if (typeof value === "string") return value === "" ? [] : [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function rolesOf(payload: JWTPayload, claimPath: string, roleMap: OidcIdentityResolverConfig["roleMap"]): string[] {
  const values = claimValues(payload, claimPath);
  if (!roleMap) return values;
  // Own properties only: a claim value of "constructor" or "__proto__" maps to nothing.
  return [...new Set(values.flatMap((v) => (Object.hasOwn(roleMap, v) ? roleMap[v]! : [])))];
}

/** `<issuer>/.well-known/<name>`, with one slash however the issuer ends. */
export function wellKnown(issuer: string, name: string): URL {
  return new URL(`${issuer.replace(/\/+$/, "")}/.well-known/${name}`);
}

/** Errors that say the token is wrong, not that the keys could not be fetched. */
const TOKEN_FAULTS = new Set(["ERR_JWKS_NO_MATCHING_KEY", "ERR_JWKS_MULTIPLE_MATCHING_KEYS"]);

/**
 * The provider's keys, found through its discovery document unless named,
 * fetched once and then refreshed by `jose` as keys rotate. A failure to
 * fetch either is `IdentityProviderUnavailableError`; discovery that fails is
 * tried again on the next token rather than remembered.
 */
function remoteKeys(config: OidcIdentityResolverConfig): JWTVerifyGetKey {
  const doFetch = config.fetch ?? fetch;
  const options = config.fetch ? { [customFetch]: config.fetch as unknown as FetchImplementation } : {};
  let keys: Promise<JWTVerifyGetKey> | undefined;
  const discover = async (): Promise<JWTVerifyGetKey> => {
    if (config.jwksUrl) return createRemoteJWKSet(new URL(config.jwksUrl), options);
    const url = wellKnown(config.issuer, "openid-configuration");
    let doc: { issuer?: unknown; jwks_uri?: unknown };
    try {
      const res = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = (await res.json()) as typeof doc;
    } catch (err) {
      throw new IdentityProviderUnavailableError(`The identity provider's discovery document (${url.href}) could not be read: ${(err as Error).message}`);
    }
    // OpenID Connect Discovery 1.0, section 4.3: the document must name the issuer it was asked about.
    if (doc.issuer !== config.issuer) throw new IdentityProviderUnavailableError(`The discovery document at ${url.href} is for issuer ${JSON.stringify(doc.issuer)}, not ${JSON.stringify(config.issuer)}`);
    if (typeof doc.jwks_uri !== "string") throw new IdentityProviderUnavailableError(`The discovery document at ${url.href} names no jwks_uri`);
    let jwksUri: URL;
    try {
      jwksUri = new URL(doc.jwks_uri);
    } catch {
      throw new IdentityProviderUnavailableError(`The discovery document at ${url.href} names a jwks_uri that is not a URL`);
    }
    return createRemoteJWKSet(jwksUri, options);
  };
  return async (header, token) => {
    keys ??= discover().catch((err: unknown) => {
      keys = undefined;
      throw err;
    });
    const getKey = await keys;
    try {
      return await getKey(header, token);
    } catch (err) {
      if (TOKEN_FAULTS.has((err as { code?: string }).code ?? "")) throw err;
      throw new IdentityProviderUnavailableError(`The identity provider's signing keys could not be fetched: ${(err as Error).message}`);
    }
  };
}

/**
 * Real OIDC/JWT identity resolution (see ADR-0018) — verifies a bearer
 * token's signature and `iss`/`aud` claims via `jose`, then maps it onto
 * this project's `Identity` shape. Fails closed to an anonymous identity
 * by default: a bad token is "denied by policy," not a crash.
 */
export function createOidcIdentityResolver(config: OidcIdentityResolverConfig): IdentityResolver {
  const jwks = config.jwks ?? remoteKeys(config);
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
        roles: rolesOf(payload, rolesClaim, config.roleMap),
        attributes: payload,
        ...(typeof scope === "string" ? { tokenScopes: scope.split(" ").filter(Boolean) } : {}),
        ...(typeof clearance === "string" ? { clearance } : {}),
        // So anything holding the identity past this request (a workflow run, ADR-0065) stops at the token's expiry.
        ...(typeof payload.exp === "number" ? { expiresAt: new Date(payload.exp * 1000).toISOString() } : {})
      };
    } catch (err) {
      if (!failOpen) throw err;
      return anonymousIdentity();
    }
  };
}
