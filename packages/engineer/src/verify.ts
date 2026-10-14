import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { loadHost } from "./host.js";
import { parseMission, type AcceptanceCheck, type EngineerDiagnostic, type MissionSpec } from "./mission.js";
import { planMission, type MissionPlan } from "./plan.js";

const run = promisify(execFile);

const require = createRequire(import.meta.url);

/** One acceptance check, decided through the application's API. */
export interface CheckResult {
  readonly id: string;
  readonly ok: boolean;
  /** What the API answered, enough to see why a check failed. */
  readonly observed: unknown;
  readonly diagnostic?: EngineerDiagnostic;
}

/**
 * The verdict on an application (ADR-0071): the plan, the build, and every
 * acceptance check run against the built application. `ok` only when the
 * plan has no error, the application compiles, and every check passes.
 */
export interface VerifyReport {
  readonly mission: string;
  readonly ok: boolean;
  readonly stages: { readonly plan: boolean; readonly build: boolean; readonly checks: boolean };
  readonly plan?: MissionPlan;
  readonly checks: readonly CheckResult[];
  readonly diagnostics: readonly EngineerDiagnostic[];
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

async function call(baseUrl: string, token: string, method: "GET" | "POST", url: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${baseUrl}/api${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    // Not JSON: keep the text, so the report shows what came back.
  }
  return { status: res.status, body: parsed };
}

const refusal = (a: Answer) => a.status === 403 || a.status === 404;
const enc = encodeURIComponent;

/**
 * Runs one acceptance check against the application at `baseUrl`, as the
 * caller it names, through the same API a client uses. Never throws for a
 * failed check: it returns what was observed and a `check-failed`
 * diagnostic saying what to look at.
 */
export async function runCheck(baseUrl: string, spec: MissionSpec, check: AcceptanceCheck): Promise<CheckResult> {
  const token = spec.callers[check.as]?.token ?? "";
  const fail = (observed: unknown, message: string, hint: string): CheckResult => ({
    id: check.id,
    ok: false,
    observed,
    diagnostic: { code: "check-failed", severity: "error", at: `acceptance/${spec.acceptance.indexOf(check)}`, message: `"${check.id}" failed: ${message}`, hint }
  });
  const pass = (observed: unknown): CheckResult => ({ id: check.id, ok: true, observed });

  switch (check.kind) {
    case "reads": {
      const a = await call(baseUrl, token, "GET", `/objects/${enc(check.type)}/${enc(check.objectId)}`);
      if (a.status !== 200) return fail(a, `${check.as} could not read ${check.type} ${check.objectId} (${a.status})`, "the model's read policy refuses this caller; check the caller or the requirement");
      const values = (a.body as { values?: Record<string, unknown> }).values ?? {};
      const missing = (check.sees ?? []).filter((f) => !Object.hasOwn(values, f));
      const leaked = (check.withheld ?? []).filter((f) => Object.hasOwn(values, f));
      if (missing.length > 0) return fail({ fields: Object.keys(values) }, `${check.as} does not see ${missing.join(", ")}`, "a field rule or classification withholds it");
      if (leaked.length > 0) return fail({ fields: Object.keys(values) }, `${check.as} sees ${leaked.join(", ")}, which must be withheld`, "the model releases more than the requirement allows; the fix is in the model's policy, not the application");
      return pass({ fields: Object.keys(values) });
    }
    case "refused": {
      const a = await call(baseUrl, token, "GET", `/objects/${enc(check.type)}/${enc(check.objectId)}`);
      return refusal(a) ? pass({ status: a.status }) : fail({ status: a.status }, `${check.as} read ${check.type} ${check.objectId}`, "the requirement says this caller is refused");
    }
    case "query": {
      const a = await call(baseUrl, token, "POST", "/query", check.query);
      if (a.status !== 200) return fail(a, `the query was refused (${a.status})`, "validate the query with typesys_validate_query");
      const n = ((a.body as { items?: unknown[] }).items ?? []).length;
      if (check.atLeast !== undefined && n < check.atLeast) return fail({ count: n }, `${n} results, expected at least ${check.atLeast}`, "check the query's filters, and what this caller may read");
      if (check.atMost !== undefined && n > check.atMost) return fail({ count: n }, `${n} results, expected at most ${check.atMost}`, "this caller reads more than the requirement allows");
      return pass({ count: n });
    }
    case "offered": {
      const a = await call(baseUrl, token, "GET", `/types/${enc(check.type)}/actions${check.objectId ? `?objectId=${enc(check.objectId)}` : ""}`);
      const listed = a.status === 200 ? (a.body as { name: string; authorized: boolean }[]) : [];
      const offered = listed.some((x) => x.name === check.action && x.authorized);
      return offered === check.offered
        ? pass({ offered })
        : fail({ status: a.status, offered }, `${check.action} is ${offered ? "" : "not "}offered to ${check.as}`, "the Action's policy decides who is offered it");
    }
    case "described": {
      const a = await call(baseUrl, token, "GET", "/model");
      const described = a.status === 200 && ((a.body as { types?: { name: string }[] }).types ?? []).some((t) => t.name === check.type);
      return described === check.described
        ? pass({ described })
        : fail({ status: a.status, described }, `${check.type} is ${described ? "" : "not "}described to ${check.as}`, "discovery (ADR-0068) decides who is told of a Type");
    }
    case "starts": {
      const a = await call(baseUrl, token, "POST", `/workflows/${enc(check.workflow)}/runs`, { input: check.input });
      const status = refusal(a) ? "refused" : a.status === 201 ? (a.body as { status: string }).status : `http-${a.status}`;
      const waitingOn = (a.body as { waitingOn?: { step: string } } | null)?.waitingOn?.step;
      if (status !== check.status) return fail({ status, body: a.body }, `the run is ${status}, expected ${check.status}`, "read the run's steps: the first one not completed is why");
      if (check.waitingOn !== undefined && waitingOn !== check.waitingOn) return fail({ status, waitingOn }, `the run waits on ${waitingOn ?? "nothing"}, expected ${check.waitingOn}`, "check the workflow's approval steps");
      return pass({ status, ...(waitingOn ? { waitingOn } : {}) });
    }
    case "approves": {
      const starter = spec.callers[check.startedBy]?.token ?? "";
      const started = await call(baseUrl, starter, "POST", `/workflows/${enc(check.workflow)}/runs`, { input: check.input });
      if (started.status !== 201) return fail(started, `${check.startedBy} could not start the run (${started.status})`, "a starts check for this caller says why");
      const runId = (started.body as { runId: string }).runId;
      const a = await call(baseUrl, token, "POST", `/workflow-runs/${enc(runId)}/approvals/${enc(check.step)}`, { approved: true });
      const admitted = a.status === 200;
      if (admitted !== check.admitted)
        return fail(
          { status: a.status, body: a.body },
          `${check.as} was ${admitted ? "" : "not "}admitted to approve ${check.step}`,
          admitted ? "the approval admits someone the requirement excludes: check its policy and allowSelfApproval" : "the approval's policy refuses this caller"
        );
      const then = admitted ? (a.body as { status: string }).status : undefined;
      if (check.then !== undefined && then !== check.then) return fail({ status: then, body: a.body }, `after approving, the run is ${then}, expected ${check.then}`, "read the run's steps after the approval");
      return pass({ admitted, ...(then ? { then } : {}) });
    }
  }
}

/** `tsc` errors as diagnostics: `file(line,col): error TSnnnn: message`. */
function tscDiagnostics(output: string, dir: string): EngineerDiagnostic[] {
  const out: EngineerDiagnostic[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (m) out.push({ code: "compile-error", severity: "error", at: `${path.relative(dir, path.resolve(dir, m[1]!))}:${m[2]}:${m[3]}`, message: `${m[4]}: ${m[5]}`, hint: "the application no longer matches the model or the workflow API; fix the file, or scaffold again" });
  }
  if (out.length === 0 && output.trim() !== "") out.push({ code: "compile-error", severity: "error", at: "tsconfig.json", message: output.trim().split("\n")[0]! });
  return out;
}

async function build(dir: string): Promise<EngineerDiagnostic[]> {
  const tsc = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  try {
    await run(process.execPath, [tsc, "-p", dir, "--pretty", "false"], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return tscDiagnostics(`${e.stdout ?? ""}${e.stderr ?? ""}`, dir);
  }
  if (existsSync(path.join(dir, "views.tsx"))) {
    const client = path.join(dir, "dist", "client");
    await mkdir(client, { recursive: true });
    const esbuild = await import("esbuild");
    try {
      await esbuild.build({ entryPoints: [path.join(dir, "views.tsx")], bundle: true, format: "esm", platform: "browser", jsx: "automatic",
        // The SDK reaches the core only for an in-process transport, which a browser never takes.
        external: ["@typesys/core", "node:*"],
        define: { "process.env.NODE_ENV": '"production"' }, outfile: path.join(client, "app.js"), logLevel: "silent", absWorkingDir: dir });
    } catch (err) {
      const errors = (err as { errors?: { text: string; location?: { file: string; line: number } }[] }).errors ?? [];
      return errors.map((e) => ({ code: "bundle-error", severity: "error" as const, at: e.location ? `${e.location.file}:${e.location.line}` : "views.tsx", message: e.text }));
    }
    if (existsSync(path.join(dir, "index.html"))) await copyFile(path.join(dir, "index.html"), path.join(client, "index.html"));
  }
  return [];
}

/** Runs the built application (`dist/server.js`) in its own process on a free port, and waits for it to say where it listens. */
export async function startApplication(dir: string): Promise<{ baseUrl: string; stop: () => void } | { diagnostic: EngineerDiagnostic }> {
  const server = path.join(dir, "dist", "server.js");
  if (!existsSync(server)) return { diagnostic: { code: "no-application", severity: "error", at: "server.ts", message: "the build produced no dist/server.js" } };
  const child = spawn(process.execPath, [server], { cwd: dir, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  return new Promise((resolve) => {
    const failed = (message: string) => {
      child.kill();
      resolve({ diagnostic: { code: "startup-failed", severity: "error", at: "server.ts", message, hint: "run the server yourself to see the whole error" } });
    };
    const timer = setTimeout(() => failed(`the application did not start within ${STARTUP_MS / 1000}s: ${output.trim().slice(-500)}`), STARTUP_MS);
    const listen = (chunk: Buffer) => {
      output += chunk.toString();
      const m = / on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve({ baseUrl: m[1]!, stop: () => child.kill() });
      }
    };
    child.stdout.on("data", listen);
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      failed(`the application exited (${code ?? "signal"}) before it listened: ${output.trim().slice(-500)}`);
    });
  });
}

const STARTUP_MS = 30_000;

/**
 * Verifies the application in `dir` against its `mission.json`: plan it
 * against the model, build it, start it, and run every acceptance check
 * through its API. Whatever is in `dir` is what is verified, generated or
 * edited by hand.
 */
export async function verifyMission(dir: string): Promise<VerifyReport> {
  const abs = path.resolve(dir);
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path.join(abs, "mission.json"), "utf8"));
  } catch (err) {
    const d: EngineerDiagnostic = { code: "invalid-mission", severity: "error", at: "mission.json", message: `cannot read mission.json: ${(err as Error).message}` };
    return { mission: "", ok: false, stages: { plan: false, build: false, checks: false }, checks: [], diagnostics: [d] };
  }
  const parsed = parseMission(doc);
  if (!parsed.spec) return { mission: "", ok: false, stages: { plan: false, build: false, checks: false }, checks: [], diagnostics: parsed.diagnostics };
  const spec = parsed.spec;

  const { host, resolve, workflows } = await loadHost(spec, abs);
  const plan = await planMission(spec, host, resolve, workflows);
  const fail = (stages: VerifyReport["stages"], diagnostics: readonly EngineerDiagnostic[], checks: readonly CheckResult[] = []): VerifyReport => ({
    mission: spec.name,
    ok: false,
    stages,
    plan,
    checks,
    diagnostics: [...plan.diagnostics, ...diagnostics]
  });
  if (!plan.ok) return fail({ plan: false, build: false, checks: false }, []);

  const built = await build(abs);
  if (built.length > 0) return fail({ plan: true, build: false, checks: false }, built);

  // The built application, started fresh in its own process, as it would be deployed: every check sees the state the spec describes, and nothing of an earlier build.
  const app = await startApplication(abs);
  if ("diagnostic" in app) return fail({ plan: true, build: true, checks: false }, [app.diagnostic]);
  const checks: CheckResult[] = [];
  try {
    for (const check of spec.acceptance) checks.push(await runCheck(app.baseUrl, spec, check));
  } finally {
    app.stop();
  }
  const failed = checks.flatMap((c) => (c.diagnostic ? [c.diagnostic] : []));
  if (failed.length > 0) return fail({ plan: true, build: true, checks: false }, failed, checks);
  return { mission: spec.name, ok: true, stages: { plan: true, build: true, checks: true }, plan, checks, diagnostics: plan.diagnostics };
}
