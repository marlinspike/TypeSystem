import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response, type Router } from "express";

/**
 * The page may load only its own script, style and API: no inline script,
 * no other origin, no framing. A token kept in the page is then reachable
 * only by the app's own code.
 */
export const CLIENT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

function hardened(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", CLIENT_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

export interface ClientRouterOptions {
  /** The bundled client: `index.html`, its script and stylesheet. */
  readonly dir: string;
  /** Served as JSON at `configPath`: what the page needs before it signs in. Never a secret the page's visitor should not have. */
  readonly config?: unknown;
  /** Default `/config.json`. */
  readonly configPath?: string;
  /**
   * A single-page application with its own routes: a GET for an HTML page
   * no file matches (`/shipments/S-1`) is answered with `index.html`, so a
   * deep link or a reload reaches the client's router. Never under `/api`.
   */
  readonly spa?: boolean;
}

/**
 * A browser client beside the governed API (ADR-0061): its static files and
 * configuration, under `CLIENT_CSP` and the usual hardening headers. A
 * client not yet built answers 503 rather than an empty page. Mount it on
 * the app `createApiApp` returns, so the API's Host and Origin checks apply
 * to the client's calls.
 */
export function clientRouter(opts: ClientRouterOptions): Router {
  const router = express.Router();
  router.use(hardened);
  if (opts.config !== undefined) {
    const config = opts.config;
    router.get(opts.configPath ?? "/config.json", (_req, res) => void res.json(config));
  }
  if (existsSync(opts.dir)) {
    router.use(express.static(opts.dir, { index: "index.html", fallthrough: true }));
    if (opts.spa) {
      const index = path.join(opts.dir, "index.html");
      router.get(/^\/(?!api(\/|$)).*/, (req, res, next) => (req.accepts("html") && !path.extname(req.path) ? res.sendFile(index) : next()));
    }
  }
  else router.get("/", (_req, res) => void res.status(503).type("text/plain").send("The client is not built. Run npm run build."));
  return router;
}
