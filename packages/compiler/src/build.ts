import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { AppDiagnostic } from "./diagnostics.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * The compiler options the build owns (as `typesys engineer verify` owns
 * them, ADR-0071): where output goes, that there is output, and that no
 * earlier build is reused. What runs is what is in the directory now.
 */
const OWNED_TSC_FLAGS = (dir: string) => [
  "--outDir", path.join(dir, "dist"),
  "--noEmit", "false",
  "--incremental", "false",
  "--composite", "false",
  "--declaration", "false",
  "--sourceMap", "false",
  "--strict",
  "--noUncheckedIndexedAccess"
];

/** tsc's errors as diagnostics at `file:line:col`, generated and handwritten files alike. */
export function tscDiagnostics(output: string, dir: string): AppDiagnostic[] {
  const out: AppDiagnostic[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (!m) continue;
    const file = path.relative(dir, path.resolve(dir, m[1]!));
    const generated = file.startsWith(`src${path.sep}generated`) || file === "server.ts";
    out.push({
      code: "compile-error",
      severity: "error",
      at: `${file}:${m[2]}:${m[3]}`,
      message: `${m[4]}: ${m[5]}`,
      hint: generated
        ? file.endsWith("contracts-check.ts")
          ? "a handwritten extension no longer matches its contract in src/generated/contracts.ts: change the extension, or the call in app.json"
          : "generated code that does not type-check is a compiler defect, or a model the application was compiled against has changed: run typesys app compile again"
        : "fix the handwritten file"
    });
  }
  if (out.length === 0 && output.trim() !== "") out.push({ code: "compile-error", severity: "error", at: "tsconfig.json", message: output.trim().split("\n")[0]! });
  return out;
}

/**
 * Builds a compiled application (ADR-0082): tsc type-checks every file,
 * generated and handwritten, and emits the server to `dist/`; esbuild
 * bundles the client from `src/generated/app.tsx` with the design system's
 * stylesheet to `dist/client/`. Nothing of an earlier build survives.
 */
export async function buildApp(dir: string): Promise<AppDiagnostic[]> {
  const abs = path.resolve(dir);
  const dist = path.join(abs, "dist");
  await rm(dist, { recursive: true, force: true });
  const tsc = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  try {
    await run(process.execPath, [tsc, "-p", abs, "--pretty", "false", ...OWNED_TSC_FLAGS(abs)], { cwd: abs, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return tscDiagnostics(`${e.stdout ?? ""}${e.stderr ?? ""}`, abs);
  }
  if (!existsSync(path.join(dist, "server.js"))) return [{ code: "no-application", severity: "error", at: "server.ts", message: "the build produced no dist/server.js", hint: "compile the application first: typesys app compile" }];
  const entry = path.join(abs, "src", "generated", "app.tsx");
  if (!existsSync(entry)) return [];
  const client = path.join(dist, "client");
  await mkdir(client, { recursive: true });
  const esbuild = await import("esbuild");
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      minify: true,
      // The SDK reaches the core only for an in-process transport, which a browser never takes.
      external: ["@typesys/core", "node:*"],
      define: { "process.env.NODE_ENV": '"production"' },
      outfile: path.join(client, "app.js"),
      logLevel: "silent",
      absWorkingDir: abs
    });
  } catch (err) {
    const errors = (err as { errors?: { text: string; location?: { file: string; line: number } }[] }).errors ?? [];
    return errors.map((e) => ({ code: "bundle-error", severity: "error" as const, at: e.location ? `${e.location.file}:${e.location.line}` : "src/generated/app.tsx", message: e.text }));
  }
  const appRequire = createRequire(path.join(abs, "noop.js"));
  await copyFile(appRequire.resolve("@typesys/ui/styles.css"), path.join(client, "app.css"));
  if (existsSync(path.join(abs, "index.html"))) await copyFile(path.join(abs, "index.html"), path.join(client, "index.html"));
  return [];
}
