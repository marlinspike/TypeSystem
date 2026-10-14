import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { measureCode, percentile } from "./measure.js";
import type { ArmId, CheckApi, CheckOutcome, HiddenCheck, ProductionLog, RunScore } from "./types.js";

const run = promisify(execFile);
const STARTUP_MS = 60_000;
const CONCURRENCY = 4;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

interface Running {
  readonly baseUrl: string;
  stop(): void;
}

/**
 * Starts the application with `npm start` on a free port, as the contract
 * says, and waits until `GET /api/me` answers. The whole process group is
 * stopped afterwards, so a service the application started goes with it.
 */
export async function startApp(dir: string): Promise<Running | { error: string }> {
  const port = await freePort();
  const child = spawn("npm", ["start", "--silent"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  const stop = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + STARTUP_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { error: `the application exited (${child.exitCode}) before it answered: ${output.trim().slice(-400)}` };
    try {
      await fetch(`${baseUrl}/api/me`);
      return { baseUrl, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  stop();
  return { error: `the application did not answer within ${STARTUP_MS / 1000}s: ${output.trim().slice(-400)}` };
}

function apiFor(baseUrl: string, latencies: number[]): CheckApi {
  return {
    async call(token, method, p, body) {
      const started = performance.now();
      const res = await fetch(`${baseUrl}${p}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const text = await res.text();
      const ms = performance.now() - started;
      latencies.push(ms);
      let parsed: unknown;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed, ms };
    }
  };
}

export async function loadHidden(file: string): Promise<HiddenCheck[]> {
  return ((await import(pathToFileURL(file).href)) as { default: HiddenCheck[] }).default;
}

/** Runs `npm run build` when the application has a build script. */
async function buildApp(dir: string): Promise<string | undefined> {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.start) return "package.json has no start script";
  if (!pkg.scripts.build) return undefined;
  try {
    await run("npm", ["run", "build", "--silent"], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
    return undefined;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `the build failed: ${`${e.stdout ?? ""}${e.stderr ?? ""}`.trim().slice(-600)}`;
  }
}

/**
 * Scores an application against a task's hidden checks: build it, then run
 * each check against its own freshly started copy, so no check depends on
 * another. Records every outcome, the code measures and request latency.
 */
export async function scoreApp(opts: { task: string; arm: ArmId; dir: string; hidden: readonly HiddenCheck[]; production: ProductionLog }): Promise<RunScore> {
  const base = { task: opts.task, arm: opts.arm, at: new Date().toISOString(), production: opts.production, total: opts.hidden.length };
  const nothing = (diagnostic: string, built: boolean): RunScore => ({ ...base, built, started: false, diagnostic, checks: [], passed: 0, ...(existsSync(opts.dir) ? { code: measureCode(opts.dir) } : {}) });
  if (!existsSync(path.join(opts.dir, "package.json"))) return nothing("no package.json", false);
  const buildError = await buildApp(opts.dir);
  if (buildError) return nothing(buildError, false);

  const latencies: number[] = [];
  const outcomes: (CheckOutcome | undefined)[] = new Array<CheckOutcome | undefined>(opts.hidden.length);
  let started = false;
  let startError: string | undefined;
  let next = 0;
  const worker = async () => {
    while (next < opts.hidden.length) {
      const i = next++;
      const check = opts.hidden[i]!;
      const app = await startApp(opts.dir);
      if ("error" in app) {
        startError ??= app.error;
        outcomes[i] = { id: check.id, ok: false, message: app.error };
        continue;
      }
      started = true;
      try {
        await check.run(apiFor(app.baseUrl, latencies));
        outcomes[i] = { id: check.id, ok: true };
      } catch (err) {
        outcomes[i] = { id: check.id, ok: false, message: err instanceof Error ? err.message : String(err) };
      } finally {
        app.stop();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, opts.hidden.length) }, worker));
  const checks = outcomes.filter((c): c is CheckOutcome => c !== undefined);
  return {
    ...base,
    built: true,
    started,
    ...(started ? {} : { diagnostic: startError ?? "the application never answered" }),
    checks,
    passed: checks.filter((c) => c.ok).length,
    code: measureCode(opts.dir),
    performance: { requests: latencies.length, p50Ms: Math.round(percentile(latencies, 50)), p95Ms: Math.round(percentile(latencies, 95)) }
  };
}
