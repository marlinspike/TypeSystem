/**
 * Bundles the browser clients into each package's `dist/public`: one
 * script, one stylesheet and the page, which is all the client Content
 * Security Policy (`@typesys/http`'s CLIENT_CSP) lets a page load. The
 * Studio (ADR-0061) and the two mission applications (ADR-0063). Runs after
 * `tsc -b` in `npm run build`.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages");

interface ClientBuild {
  /** The entry point, relative to `packages/`. */
  readonly entry: string;
  /** The output directory, relative to `packages/`. */
  readonly out: string;
  /** The bundle's file name, as the page loads it. */
  readonly script: string;
  /** Copied beside the bundle, relative to `packages/`. */
  readonly assets: readonly string[];
}

const CLIENTS: readonly ClientBuild[] = [
  { entry: "studio/src/client/main.tsx", out: "studio/dist/public", script: "studio.js", assets: ["studio/src/client/index.html", "studio/src/client/studio.css"] },
  ...(["composed", "handwritten"] as const).map((app) => ({
    entry: `mission-readiness/src/${app}/client/main.tsx`,
    out: `mission-readiness/dist/public/${app}`,
    script: "mission.js",
    assets: ["mission-readiness/src/shared/client/index.html", "mission-readiness/src/shared/client/mission.css"]
  }))
];

await Promise.all(
  CLIENTS.map(async (c) => {
    const out = path.join(packages, c.out);
    await mkdir(out, { recursive: true });
    await build({
      entryPoints: [path.join(packages, c.entry)],
      outfile: path.join(out, c.script),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      minify: true,
      sourcemap: true,
      legalComments: "linked",
      define: { "process.env.NODE_ENV": '"production"' },
      // Clients use only core's types. The SDK's in-process transport loads core on use, which a browser never does.
      external: ["@typesys/core"],
      logLevel: "warning"
    });
    await Promise.all(c.assets.map((a) => copyFile(path.join(packages, a), path.join(out, path.basename(a)))));
  })
);
