import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createApiApp, type ApiAppOptions } from "@typesys/http";

/** Where `npm run build` writes the bundled client: this package's `dist/public`, from `dist` or from source. */
export const STUDIO_CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/public");

export interface StudioOptions extends ApiAppOptions {
  /** Shown in the header. */
  readonly title?: string;
  /**
   * Named bearer tokens offered as one-click sign-ins, for a demonstration
   * only: anyone who can open the Studio can use them. A deployment leaves
   * this out and each person pastes their own token.
   */
  readonly demoTokens?: Readonly<Record<string, string>>;
  /** The bundled client. Default: this package's `dist/public`. */
  readonly clientDir?: string;
}

/**
 * The page may load only its own script, style and API: no inline script,
 * no other origin, no framing. A token kept in the page is then reachable
 * only by the Studio's own code.
 */
const CSP = [
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
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

/**
 * TypeS Studio (ADR-0061): the governed API under `/api` (ADR-0058) and a
 * browser client that uses nothing else. The Studio has no authority of
 * its own: every call it makes carries the signed-in person's bearer token,
 * so what it shows is what the runtime decides for them.
 */
export function createStudioApp(opts: StudioOptions): Express {
  const app = createApiApp(opts);
  const clientDir = opts.clientDir ?? STUDIO_CLIENT_DIR;
  const studio = express.Router();
  studio.use(hardened);
  studio.get("/studio/config.json", (_req, res) => {
    res.json({ title: opts.title ?? "TypeS Studio", demo: opts.demoTokens ? Object.entries(opts.demoTokens).map(([label, token]) => ({ label, token })) : null });
  });
  if (existsSync(clientDir)) studio.use(express.static(clientDir, { index: "index.html", fallthrough: true }));
  else studio.get("/", (_req, res) => void res.status(503).type("text/plain").send("The Studio client is not built. Run npm run build."));
  app.use(studio);
  return app;
}
