import express, { type Request, type Response, type Router } from "express";
import { IdentityProviderUnavailableError, type Identity, type IdentityResolver } from "@typesys/core";
import { bearerToken, hostnameOf } from "./guard.js";

/**
 * How a server's callers sign in (ADR-0116): what it tells an MCP client, or
 * any OAuth client, about where to get a token for it. A server that has
 * this is an OAuth 2.0 protected resource (RFC 9728), as the MCP
 * authorization specification requires of a server that authorizes.
 */
export interface SignIn {
  /** The authorization server that issues the tokens: the deployment's OpenID Connect issuer. */
  readonly issuer: string;
  /**
   * The server's own address, as its clients reach it (`https://typesys.example.com`):
   * the protected resource. Default: the address of each request, from its
   * `Host` header, which the host guard has already checked (ADR-0053), and
   * `X-Forwarded-Proto` when a proxy terminated TLS.
   */
  readonly resource?: string;
  /** The scopes a client asks for (`scopes_supported`), when the provider needs them named. */
  readonly scopes?: readonly string[];
  /** A request with no token is answered 401 with a challenge, not served as anonymous. Default true. */
  readonly requireToken?: boolean;
  /** Shown by clients that display it. */
  readonly resourceName?: string;
}

/** The two places RFC 9728 lets a client look for the metadata: the origin's, and the one for the `/mcp` path. */
export const PROTECTED_RESOURCE_PATHS = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"] as const;

const ORIGIN = /^https?:\/\/[^/?#]+$/;

/** `resource` as given, or this request's own origin. */
export function resourceOf(signIn: SignIn, req: Request): string {
  if (signIn.resource) return signIn.resource.replace(/\/+$/, "");
  const host = req.header("host");
  const forwarded = req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : req.protocol;
  // A Host that is not host[:port] never reaches a challenge: the guard refuses it first. Should one, name no resource from it.
  return hostnameOf(host) !== undefined ? `${proto}://${host}` : "";
}

/** The metadata URL a challenge names. */
export function metadataUrl(signIn: SignIn, req: Request): string {
  return `${resourceOf(signIn, req)}${PROTECTED_RESOURCE_PATHS[0]}`;
}

/** Validates a `SignIn` as a server is built: a resource that is not an origin would send clients somewhere else. */
export function checkSignIn(signIn: SignIn): void {
  if (!signIn.issuer) throw new TypeError("signIn.issuer is required");
  if (signIn.resource !== undefined && !ORIGIN.test(signIn.resource.replace(/\/+$/, ""))) throw new TypeError(`signIn.resource must be an origin such as https://typesys.example.com, not ${JSON.stringify(signIn.resource)}`);
}

/** RFC 9728's Protected Resource Metadata, served at both well-known paths. Unauthenticated: it names only the issuer and this server. */
export function protectedResourceRouter(signIn: SignIn): Router {
  checkSignIn(signIn);
  const router = express.Router();
  for (const path of PROTECTED_RESOURCE_PATHS)
    router.get(path, (req: Request, res: Response) => {
      // Derived from the request's Host, the answer is that request's own: never kept for anyone else.
      res.setHeader("Cache-Control", signIn.resource ? "public, max-age=300" : "no-store");
      res.json({
        resource: resourceOf(signIn, req),
        authorization_servers: [signIn.issuer],
        bearer_methods_supported: ["header"],
        ...(signIn.scopes?.length ? { scopes_supported: signIn.scopes } : {}),
        ...(signIn.resourceName ? { resource_name: signIn.resourceName } : {})
      });
    });
  return router;
}

const quote = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

/** The `WWW-Authenticate` value for a request without a usable token (RFC 6750, RFC 9728 section 5.1). */
export function challengeHeader(signIn: SignIn, req: Request, error?: "invalid_token"): string {
  const parts = [`resource_metadata=${quote(metadataUrl(signIn, req))}`];
  if (signIn.scopes?.length) parts.push(`scope=${quote(signIn.scopes.join(" "))}`);
  if (error) parts.push(`error=${quote(error)}`);
  return `Bearer ${parts.join(", ")}`;
}

/** What resolving a request's caller came to. */
export type Caller =
  | { readonly kind: "identity"; readonly identity: Identity; readonly token: string | undefined }
  /** No token, and one is required: answer 401 with a challenge. */
  | { readonly kind: "missing" }
  /** A token the resolver refused: answer 401 with `error="invalid_token"`. */
  | { readonly kind: "invalid" }
  /** The identity provider could not be reached: answer 503. */
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * The caller of one request, resolved once from its bearer token. With a
 * `signIn`, a missing token is refused when it requires one; without, the
 * resolver decides what no token means (an anonymous identity), as before.
 */
export async function resolveCaller(req: Request, resolver: IdentityResolver, signIn: SignIn | undefined, fallbackToken?: string): Promise<Caller> {
  const token = bearerToken(req) ?? fallbackToken;
  if (!token && signIn && signIn.requireToken !== false) return { kind: "missing" };
  try {
    return { kind: "identity", identity: await resolver(token ?? null), token };
  } catch (err) {
    if (err instanceof IdentityProviderUnavailableError) return { kind: "unavailable", message: err.message };
    return { kind: "invalid" };
  }
}
