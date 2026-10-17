import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { runCheck, startApplication, type CheckResult, type MissionSpec } from "@typesys/engineer";
import { buildApp } from "./build.js";
import { compileApp, type CompileOptions } from "./compile.js";
import type { AppDiagnostic } from "./diagnostics.js";
import type { AppCheck, AppSpec, ScreenCheck } from "./ir.js";

/**
 * A Chromium for screen checks: `CHROME_PATH`, Playwright's browsers
 * (`PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers`), or the system's.
 * Undefined when there is none.
 */
export function findChromium(): string | undefined {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter((r): r is string => typeof r === "string" && existsSync(r));
  const candidates = [
    process.env.CHROME_PATH,
    ...roots.flatMap((r) => readdirSync(r).filter((d) => d.startsWith("chromium-")).map((d) => path.join(r, d, "chrome-linux", "chrome"))),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return candidates.find((c): c is string => typeof c === "string" && existsSync(c));
}

const SETTLE_MS = 10_000;

/** The little of the DOM a screen check reads, typed here so the compiler is not compiled against the DOM. */
interface PageDocument {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): { readonly length: number };
  readonly body: { readonly innerText: string };
}
type PageGlobals = { readonly document: PageDocument; readonly CSS: { escape(s: string): string } };

/**
 * One screen check in Chromium (ADR-0084): the page opened as the caller
 * (their token in the session, as signing in leaves it), every data node
 * left to settle, then what is on screen compared with what the check
 * expects. A node is found by its stable `id` (`data-node`), a row by its
 * object id (`data-row`). Text is the page's visible text.
 */
export async function runScreenCheck(baseUrl: string, spec: AppSpec, check: ScreenCheck): Promise<CheckResult> {
  const chrome = findChromium();
  const fail = (observed: unknown, message: string): CheckResult => ({ id: check.id, ok: false, observed, diagnostic: { code: "check-failed", severity: "error", at: `acceptance/${spec.acceptance.indexOf(check)}`, message: `${check.id}: ${message}`, hint: "open the page as this caller and compare" } });
  if (!chrome) return fail(null, "no Chromium to run a screen check in (set CHROME_PATH)");
  const page0 = spec.pages.find((p) => p.name === check.page);
  if (!page0) return fail(null, `no page ${check.page}`);
  const url = baseUrl + page0.path.split("/").map((seg) => (seg.startsWith(":") ? encodeURIComponent(check.params?.[seg.slice(1)] ?? "") : seg)).join("/");
  const token = spec.callers[check.as]?.token ?? "";
  const { chromium } = await import("playwright-core");
  // Chromium's sandbox cannot run as root (a container's usual user); anyone else keeps it.
  const browser = await chromium.launch({ executablePath: chrome, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (e) => errors.push(e.message));
    // A script or stylesheet that does not load leaves a page that never mounts, which throws nothing.
    const own = new URL(baseUrl).origin;
    const asset = (u: string, type: string) => new URL(u).origin === own && ["document", "script", "stylesheet"].includes(type);
    page.on("requestfailed", (r) => asset(r.url(), r.resourceType()) && errors.push(`${r.url()} did not load`));
    page.on("response", (r) => r.status() >= 400 && asset(r.url(), r.request().resourceType()) && errors.push(`${r.url()} answered ${r.status()}`));
    await page.addInitScript((t: string) => {
      try {
        if (t) sessionStorage.setItem("typesys.token", t);
        else sessionStorage.removeItem("typesys.token");
      } catch {
        // No storage: the check runs signed out.
      }
    }, token);
    await page.goto(url);
    // Settled: the shell is up and no node is still loading, twice in a row a moment apart.
    const deadline = Date.now() + SETTLE_MS;
    let quiet = 0;
    while (Date.now() < deadline && quiet < 2) {
      const loading = await page.evaluate(() => {
        const { document } = globalThis as unknown as PageGlobals;
        return document.querySelector(".ts-app") === null || document.querySelectorAll('[data-state="loading"], [aria-busy="true"]').length > 0;
      });
      quiet = loading ? 0 : quiet + 1;
      await page.waitForTimeout(250);
    }
    // A negative expectation needs a settled page to be true of: one that never settled shows nothing, which proves nothing.
    if (quiet < 2) return fail({ errors }, `the page did not settle within ${SETTLE_MS / 1000} s${errors.length ? `: ${errors.join("; ")}` : ""}`);
    const observed = await page.evaluate(
      (c: { visible: string[]; hidden: string[]; rows: string[] }) => {
        const { document, CSS } = globalThis as unknown as PageGlobals;
        return {
          present: Object.fromEntries([...c.visible, ...c.hidden].map((id) => [id, document.querySelector(`[data-node="${CSS.escape(id)}"]`) !== null])),
          // The rows the node was given (a table shows one page of them), else the rows it draws.
          rows: Object.fromEntries(
            c.rows.map((id) => {
              const node = document.querySelector(`[data-node="${CSS.escape(id)}"]`) as { getAttribute(n: string): string | null } | null;
              const given = node?.getAttribute("data-rows");
              return [id, given != null ? Number(given) : document.querySelectorAll(`[data-node="${CSS.escape(id)}"] [data-row]`).length];
            })
          ),
          text: document.body.innerText
        };
      },
      { visible: [...(check.visible ?? [])], hidden: [...(check.hidden ?? [])], rows: Object.keys(check.rows ?? {}) }
    );
    const problems: string[] = [];
    for (const id of check.visible ?? []) if (!observed.present[id]) problems.push(`node ${id} is not shown`);
    for (const id of check.hidden ?? []) if (observed.present[id]) problems.push(`node ${id} is shown`);
    for (const t of check.text ?? []) if (!observed.text.includes(t)) problems.push(`the page does not say "${t}"`);
    for (const t of check.absentText ?? []) if (observed.text.includes(t)) problems.push(`the page says "${t}"`);
    for (const [id, want] of Object.entries(check.rows ?? {})) {
      const n = observed.rows[id] ?? 0;
      if (want.atLeast !== undefined && n < want.atLeast) problems.push(`${id} shows ${n} rows, fewer than ${want.atLeast}`);
      if (want.atMost !== undefined && n > want.atMost) problems.push(`${id} shows ${n} rows, more than ${want.atMost}`);
    }
    if (errors.length) problems.push(`the page threw: ${errors.join("; ")}`);
    const summary = { present: observed.present, rows: observed.rows, errors };
    return problems.length ? fail(summary, problems.join("; ")) : { id: check.id, ok: true, observed: summary };
  } finally {
    await browser.close();
  }
}

/** One acceptance check against its own freshly started copy of the built application in `root`. */
export async function runAppCheck(root: string, spec: AppSpec, check: AppCheck): Promise<CheckResult> {
  const app = await startApplication(root);
  if ("diagnostic" in app) return { id: check.id, ok: false, observed: null, diagnostic: { ...app.diagnostic, at: `acceptance/${spec.acceptance.indexOf(check)}` } };
  try {
    // An API check is the engineering loop's own (ADR-0071), which reads only the callers and the check's position.
    return check.kind === "screen" ? await runScreenCheck(app.baseUrl, spec, check) : await runCheck(app.baseUrl, spec as unknown as MissionSpec, check);
  } finally {
    app.stop();
  }
}

export interface AppVerifyReport {
  readonly app: string;
  readonly ok: boolean;
  readonly stages: { readonly check: boolean; readonly build: boolean; readonly acceptance: boolean };
  readonly checks: readonly CheckResult[];
  readonly diagnostics: readonly AppDiagnostic[];
  /** Generated files the compile changed. */
  readonly written: readonly string[];
}

const CONCURRENCY = 4;

/**
 * Verifies the application in `dir` (ADR-0084): check and compile it, build
 * it, and run every acceptance check against its own freshly started copy,
 * API checks through the API and screen checks in Chromium. `ok` only when
 * all three stages pass. Independent of how the code was written: a
 * handwritten extension is verified with the rest.
 */
export async function verifyApp(dir: string, options: CompileOptions = {}): Promise<AppVerifyReport> {
  const abs = path.resolve(dir);
  const compiled = await compileApp(abs, options);
  const name = compiled.analysis?.app.name ?? "";
  if (!compiled.ok) return { app: name, ok: false, stages: { check: false, build: false, acceptance: false }, checks: [], diagnostics: compiled.diagnostics, written: [] };
  const spec = compiled.analysis!.app;
  const built = await buildApp(abs);
  if (built.length) return { app: name, ok: false, stages: { check: true, build: false, acceptance: false }, checks: [], diagnostics: [...compiled.diagnostics, ...built], written: compiled.written };
  const results: (CheckResult | undefined)[] = new Array<CheckResult | undefined>(spec.acceptance.length);
  let next = 0;
  const worker = async () => {
    while (next < spec.acceptance.length) {
      const i = next++;
      results[i] = await runAppCheck(abs, spec, spec.acceptance[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, spec.acceptance.length) }, worker));
  const checks = results.filter((c): c is CheckResult => c !== undefined);
  const failed = checks.flatMap((c) => (c.diagnostic ? [c.diagnostic] : c.ok ? [] : [{ code: "check-failed", severity: "error" as const, at: `acceptance/${checks.indexOf(c)}`, message: `${c.id} failed` }]));
  return { app: name, ok: failed.length === 0, stages: { check: true, build: true, acceptance: failed.length === 0 }, checks, diagnostics: [...compiled.diagnostics, ...failed], written: compiled.written };
}
