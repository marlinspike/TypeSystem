import type { Request, Response } from "express";

/** Where a server answers by default: this machine only. */
export const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** The host name of a `Host` header value, lower-cased, without its port; `undefined` if it doesn't parse. */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The token of an `Authorization: Bearer <token>` header, if there is one. */
export function bearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

/**
 * DNS-rebinding protection (ADR-0053): answer only to an allowed `Host`, and
 * to a browser only from an allowed `Origin`. A request with no `Origin` (any
 * non-browser client) passes the origin check. Run before identity is
 * resolved, so a refused request reaches nothing. `refuse` writes the
 * transport's own error shape.
 */
export function originGuard(
  allowedHosts: readonly string[] | "*",
  allowedOrigins: readonly string[] | undefined,
  refuse: (res: Response, message: string) => void
): (req: Request, res: Response, next: () => void) => void {
  const hosts = allowedHosts === "*" ? undefined : new Set(allowedHosts.map((h) => h.toLowerCase()));
  const origins = allowedOrigins ? new Set(allowedOrigins.map((o) => o.toLowerCase())) : undefined;
  return (req, res, next) => {
    const host = hostnameOf(req.header("host"));
    if (hosts && (host === undefined || !hosts.has(host))) {
      refuse(res, "Forbidden: Host not allowed");
      return;
    }
    const origin = req.header("origin");
    if (origin !== undefined) {
      let allowed: boolean;
      if (origins) allowed = origins.has(origin.toLowerCase());
      else {
        try {
          const url = new URL(origin);
          allowed = (url.protocol === "http:" || url.protocol === "https:") && (hosts === undefined || hosts.has(url.hostname.toLowerCase()));
        } catch {
          allowed = false;
        }
      }
      if (!allowed) {
        refuse(res, "Forbidden: Origin not allowed");
        return;
      }
    }
    next();
  };
}
