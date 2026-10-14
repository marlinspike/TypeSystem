import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { tryLoadHost } from "./host.js";
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

const enc = encodeURIComponent;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Runs one acceptance check against the application at `baseUrl`, as the
 * caller it names, through the same API a client uses. Never throws for a
 * failed check: it returns what was observed and a `check-failed`
 * diagnostic saying what to look at.
 *
 * A negative check passes only on a positive signal from the runtime: a
 * 403, or a well-formed answer that lacks what is refused. A missing route,
 * an error page or a body of the wrong shape fails every check, so an
 * application that does nothing passes none.
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
  const unanswered = (a: Answer, what: string) =>
    fail({ status: a.status, body: a.body }, `the API did not answer ${what} (${a.status})`, "the application must serve the governed API at /api; start it yourself and call the route");

  switch (check.kind) {
    case "reads": {
      const a = await call(baseUrl, token, "GET", `/objects/${enc(check.type)}/${enc(check.objectId)}`);
      if (a.status === 404) return fail(a, `${check.type} ${check.objectId} was not found for ${check.as} (404)`, "the object does not exist, or the model hides it from this caller; check the id and the read policy");
      if (a.status !== 200) return fail(a, `${check.as} could not read ${check.type} ${check.objectId} (${a.status})`, "the model's read policy refuses this caller; check the caller or the requirement");
      const values = isRecord(a.body) ? a.body.values : undefined;
      if (!isRecord(values)) return unanswered(a, "with an object");
      const missing = (check.sees ?? []).filter((f) => !Object.hasOwn(values, f));
      const leaked = (check.withheld ?? []).filter((f) => Object.hasOwn(values, f));
      if (missing.length > 0) return fail({ fields: Object.keys(values) }, `${check.as} does not see ${missing.join(", ")}`, "a field rule or classification withholds it");
      if (leaked.length > 0) return fail({ fields: Object.keys(values) }, `${check.as} sees ${leaked.join(", ")}, which must be withheld`, "the model releases more than the requirement allows; the fix is in the model's policy, not the application");
      return pass({ fields: Object.keys(values) });
    }
    case "refused": {
      const url = `/objects/${enc(check.type)}/${enc(check.objectId)}`;
      const a = await call(baseUrl, token, "GET", url);
      if (a.status === 403) return pass({ status: 403 });
      if (a.status === 200) return fail({ status: 200 }, `${check.as} read ${check.type} ${check.objectId}`, "the requirement says this caller is refused");
      if (a.status === 404) {
        // A 404 is a refusal only when the object exists and the runtime hides it from this caller (ADR-0068): some other caller must read it.
        for (const [name, caller] of Object.entries(spec.callers)) {
          if (name !== check.as && (await call(baseUrl, caller.token, "GET", url)).status === 200) return pass({ status: 404, readBy: name });
        }
        return fail({ status: 404 }, `no caller found ${check.type} ${check.objectId}, so its 404 says nothing about ${check.as}`, "name an object that exists, and that some caller of the mission may read");
      }
      return unanswered(a, "with a refusal or the object");
    }
    case "query": {
      const a = await call(baseUrl, token, "POST", "/query", check.query);
      if (a.status !== 200) return fail(a, `the query was refused (${a.status})`, "validate the query with typesys_validate_query");
      const items = isRecord(a.body) ? a.body.items : undefined;
      if (!Array.isArray(items)) return unanswered(a, "with a list of items");
      const n = items.length;
      if (check.atLeast !== undefined && n < check.atLeast) return fail({ count: n }, `${n} results, expected at least ${check.atLeast}`, "check the query's filters, and what this caller may read");
      if (check.atMost !== undefined && n > check.atMost) return fail({ count: n }, `${n} results, expected at most ${check.atMost}`, "this caller reads more than the requirement allows");
      return pass({ count: n });
    }
    case "offered": {
      const a = await call(baseUrl, token, "GET", `/types/${enc(check.type)}/actions${check.objectId ? `?objectId=${enc(check.objectId)}` : ""}`);
      let offered: boolean;
      if (a.status === 403) offered = false;
      else if (a.status === 200 && Array.isArray(a.body)) offered = (a.body as unknown[]).some((x) => isRecord(x) && x.name === check.action && x.authorized === true);
      else return unanswered(a, "with the Type's Actions");
      return offered === check.offered
        ? pass({ status: a.status, offered })
        : fail({ status: a.status, offered }, `${check.action} is ${offered ? "" : "not "}offered to ${check.as}`, "the Action's policy decides who is offered it");
    }
    case "described": {
      const a = await call(baseUrl, token, "GET", "/model");
      let described: boolean;
      if (a.status === 401 || a.status === 403) described = false;
      else if (a.status === 200 && isRecord(a.body) && Array.isArray(a.body.types)) described = (a.body.types as unknown[]).some((t) => isRecord(t) && t.name === check.type);
      else return unanswered(a, "with the model");
      return described === check.described
        ? pass({ status: a.status, described })
        : fail({ status: a.status, described }, `${check.type} is ${described ? "" : "not "}described to ${check.as}`, "discovery (ADR-0068) decides who is told of a Type");
    }
    case "starts": {
      const a = await call(baseUrl, token, "POST", `/workflows/${enc(check.workflow)}/runs`, { input: check.input });
      const runStatus = a.status === 201 && isRecord(a.body) && typeof a.body.status === "string" ? a.body.status : undefined;
      const status = a.status === 403 ? "refused" : (runStatus ?? `http-${a.status}`);
      const waitingOn = isRecord(a.body) && isRecord(a.body.waitingOn) && typeof a.body.waitingOn.step === "string" ? a.body.waitingOn.step : undefined;
      if (status !== check.status) return fail({ status, body: a.body }, `the run is ${status}, expected ${check.status}`, "read the run's steps: the first one not completed is why");
      if (check.waitingOn !== undefined && waitingOn !== check.waitingOn) return fail({ status, waitingOn }, `the run waits on ${waitingOn ?? "nothing"}, expected ${check.waitingOn}`, "check the workflow's approval steps");
      return pass({ status, ...(waitingOn ? { waitingOn } : {}) });
    }
    case "approves": {
      const starter = spec.callers[check.startedBy]?.token ?? "";
      const started = await call(baseUrl, starter, "POST", `/workflows/${enc(check.workflow)}/runs`, { input: check.input });
      if (started.status !== 201 || !isRecord(started.body) || typeof started.body.runId !== "string")
        return fail(started, `${check.startedBy} could not start the run (${started.status})`, "a starts check for this caller says why");
      // The approval tests this caller only if the run waits on exactly that step; otherwise a refusal for another reason (a 409) would pass.
      const runStatus = started.body.status;
      const waiting = isRecord(started.body.waitingOn) ? started.body.waitingOn.step : undefined;
      if (runStatus !== "waiting-approval" || waiting !== check.step)
        return fail({ status: runStatus, waitingOn: waiting }, `the run is ${String(runStatus)}${typeof waiting === "string" ? ` on ${waiting}` : ""}, not waiting on ${check.step}`, "name the approval step the run waits on");
      const a = await call(baseUrl, token, "POST", `/workflow-runs/${enc(started.body.runId)}/approvals/${enc(check.step)}`, { approved: true });
      if (a.status !== 200 && a.status !== 403) return unanswered(a, "the approval with a decision");
      const admitted = a.status === 200;
      if (admitted !== check.admitted)
        return fail(
          { status: a.status, body: a.body },
          `${check.as} was ${admitted ? "" : "not "}admitted to approve ${check.step}`,
          admitted ? "the approval admits someone the requirement excludes: check its policy and allowSelfApproval" : "the approval's policy refuses this caller"
        );
      const then = admitted && isRecord(a.body) && typeof a.body.status === "string" ? a.body.status : undefined;
      if (check.then !== undefined && then !== check.then) return fail({ status: then, body: a.body }, `after approving, the run is ${then}, expected ${check.then}`, "read the run's steps after the approval");
      return pass({ status: a.status, admitted, ...(then ? { then } : {}) });
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

/**
 * The compiler options verify owns. The application's tsconfig chooses the
 * rest, but not where output goes, whether there is any, or whether an
 * earlier build is reused: what runs is always what is in the directory now.
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

async function build(dir: string): Promise<EngineerDiagnostic[]> {
  const dist = path.join(dir, "dist");
  // Nothing of an earlier build survives to be run in place of this one.
  await rm(dist, { recursive: true, force: true });
  const tsc = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  try {
    await run(process.execPath, [tsc, "-p", dir, "--pretty", "false", ...OWNED_TSC_FLAGS(dir)], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return tscDiagnostics(`${e.stdout ?? ""}${e.stderr ?? ""}`, dir);
  }
  if (!existsSync(path.join(dist, "server.js")))
    return [{ code: "no-application", severity: "error", at: "server.ts", message: "the build produced no dist/server.js", hint: "the application's entry point is server.ts at the top of its directory" }];
  if (existsSync(path.join(dir, "views.tsx"))) {
    const client = path.join(dist, "client");
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

/**
 * Runs the built application (`dist/server.js`) in its own process on a
 * free port. It is ready when it prints `typesys-engineer-ready <nonce>
 * <url>` with the nonce verify gave it, so nothing else the application
 * prints can be taken for its address.
 */
export async function startApplication(dir: string): Promise<{ baseUrl: string; stop: () => void } | { diagnostic: EngineerDiagnostic }> {
  const server = path.join(dir, "dist", "server.js");
  if (!existsSync(server)) return { diagnostic: { code: "no-application", severity: "error", at: "server.ts", message: "the build produced no dist/server.js" } };
  const nonce = randomBytes(12).toString("hex");
  const child = spawn(process.execPath, [server], { cwd: dir, env: { ...process.env, PORT: "0", TYPESYS_ENGINEER_READY: nonce }, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new RegExp(`^typesys-engineer-ready ${nonce} (http://127\\.0\\.0\\.1:\\d+)$`, "m");
  let output = "";
  let settled = false;
  return new Promise((resolve) => {
    const failed = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ diagnostic: { code: "startup-failed", severity: "error", at: "server.ts", message, hint: "run the server yourself to see the whole error" } });
    };
    const timer = setTimeout(() => failed(`the application did not start within ${STARTUP_MS / 1000}s: ${output.trim().slice(-500)}`), STARTUP_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const m = ready.exec(output);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ baseUrl: m[1]!, stop: () => child.kill() });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => failed(`the application exited (${code ?? "signal"}) before it listened: ${output.trim().slice(-500)}`));
  });
}

const STARTUP_MS = 30_000;
/** How many applications verify runs at once, one per check. */
const CHECK_CONCURRENCY = 4;

/**
 * Runs each check against its own freshly started application, so no check
 * sees what another wrote and a verdict never depends on the order of the
 * list.
 */
async function runChecks(dir: string, spec: MissionSpec): Promise<CheckResult[]> {
  const checks: (CheckResult | undefined)[] = new Array<CheckResult | undefined>(spec.acceptance.length);
  let next = 0;
  const worker = async () => {
    while (next < spec.acceptance.length) {
      const i = next++;
      const check = spec.acceptance[i]!;
      const app = await startApplication(dir);
      if ("diagnostic" in app) {
        checks[i] = { id: check.id, ok: false, observed: null, diagnostic: { ...app.diagnostic, at: `acceptance/${i}` } };
        continue;
      }
      try {
        checks[i] = await runCheck(app.baseUrl, spec, check);
      } finally {
        app.stop();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, spec.acceptance.length) }, worker));
  return checks.filter((c): c is CheckResult => c !== undefined);
}

export interface VerifyOptions {
  /** Passed to `loadHost`: a host module given as a path must be inside this directory. */
  readonly within?: string;
}

/**
 * Verifies the application in `dir` against its `mission.json`: plan it
 * against the model, build it, and run every acceptance check through the
 * API of a freshly started copy. Whatever is in `dir` is what is verified,
 * generated or edited by hand.
 */
export async function verifyMission(dir: string, options: VerifyOptions = {}): Promise<VerifyReport> {
  const abs = path.resolve(dir);
  const none = (diagnostics: readonly EngineerDiagnostic[]): VerifyReport => ({ mission: "", ok: false, stages: { plan: false, build: false, checks: false }, checks: [], diagnostics });
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path.join(abs, "mission.json"), "utf8"));
  } catch (err) {
    // The parser's message can quote the file; say only what kind of failure it was.
    const reason = err instanceof SyntaxError ? "it is not JSON" : (err as NodeJS.ErrnoException).code === "ENOENT" ? "there is no mission.json" : "it cannot be read";
    return none([{ code: "invalid-mission", severity: "error", at: "mission.json", message: `cannot read mission.json: ${reason}` }]);
  }
  const parsed = parseMission(doc);
  if (!parsed.spec) return { ...none(parsed.diagnostics), mission: "" };
  const spec = parsed.spec;

  const loaded = await tryLoadHost(spec, abs, options);
  if ("diagnostic" in loaded) return { ...none([loaded.diagnostic]), mission: spec.name };
  const plan = await planMission(spec, loaded.host, loaded.resolve, loaded.workflows);
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

  const checks = await runChecks(abs, spec);
  const failed = checks.flatMap((c) => (c.diagnostic ? [c.diagnostic] : []));
  if (failed.length > 0) return fail({ plan: true, build: true, checks: false }, failed, checks);
  return { mission: spec.name, ok: true, stages: { plan: true, build: true, checks: true }, plan, checks, diagnostics: plan.diagnostics };
}
