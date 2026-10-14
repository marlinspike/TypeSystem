import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { clientRouter, createApiApp, type ApiAppOptions } from "@typesys/http";

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
 * TypeSys Studio (ADR-0061): the governed API under `/api` (ADR-0058) and a
 * browser client that uses nothing else. The Studio has no authority of
 * its own: every call it makes carries the signed-in person's bearer token,
 * so what it shows is what the runtime decides for them.
 */
export function createStudioApp(opts: StudioOptions): Express {
  const app = createApiApp(opts);
  app.use(
    clientRouter({
      dir: opts.clientDir ?? STUDIO_CLIENT_DIR,
      configPath: "/studio/config.json",
      config: { title: opts.title ?? "TypeSys Studio", demo: opts.demoTokens ? Object.entries(opts.demoTokens).map(([label, token]) => ({ label, token })) : null }
    })
  );
  return app;
}
