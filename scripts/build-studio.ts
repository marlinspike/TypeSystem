/**
 * Bundles the Studio's browser client (ADR-0061) into
 * `packages/studio/dist/public`: one script, one stylesheet and the page,
 * which is all the Studio's Content Security Policy lets the page load.
 * Runs after `tsc -b` in `npm run build`.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/studio");
const src = path.join(pkg, "src/client");
const out = path.join(pkg, "dist/public");

await mkdir(out, { recursive: true });
await build({
  entryPoints: [path.join(src, "main.tsx")],
  outfile: path.join(out, "studio.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  sourcemap: true,
  legalComments: "linked",
  define: { "process.env.NODE_ENV": '"production"' },
  // The client uses only core's types. The SDK's in-process transport loads core on use, which a browser never does.
  external: ["@typesys/core"],
  logLevel: "warning"
});
await Promise.all(["index.html", "studio.css"].map((f) => copyFile(path.join(src, f), path.join(out, f))));
