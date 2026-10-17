import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonical, decideForIdentity, describeModel, withAudience, type Identity } from "@typesys/core";
import { tryLoadHost, type LoadedHost, type LoadHostOptions } from "@typesys/engineer";
import { resolveConfig, type LlmConfig } from "@typesys/llm";
import { checkApp, type AppAnalysis, type CheckEnvironment } from "./check.js";
import type { AppDiagnostic } from "./diagnostics.js";
import { acceptanceSource, APP_TSCONFIG, contractsCheckSource, contractsSource, extensionStub, indexHtml, modelSource, SERVER_EXTENSION, serverSource } from "./emit/app.js";
import { flowSource } from "./emit/flows.js";
import { appSource, pageSource } from "./emit/pages.js";
import type { AppSpec } from "./ir.js";

export const LOCK_FORMAT = "typesys.app.lock/1";
export const LOCK_FILE = "typesys.lock.json";

/**
 * What the compiler last wrote (ADR-0083): a hash of the specification it
 * compiled and of every generated file. A generated file whose content no
 * longer has its hash was edited by hand, and compiling again would lose
 * that edit, so the compiler stops and says so.
 */
export interface AppLock {
  readonly format: typeof LOCK_FORMAT;
  readonly spec: string;
  readonly files: Readonly<Record<string, string>>;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** An application directory read: its specification, and the diagnostics of reading it. */
export async function readAppSpec(dir: string): Promise<{ doc?: unknown; diagnostics: AppDiagnostic[] }> {
  try {
    return { doc: JSON.parse(await readFile(path.join(dir, "app.json"), "utf8")), diagnostics: [] };
  } catch (err) {
    // The parser's message can quote the file; say only what kind of failure it was.
    const reason = err instanceof SyntaxError ? "it is not JSON" : (err as NodeJS.ErrnoException).code === "ENOENT" ? "there is no app.json" : "it cannot be read";
    return { diagnostics: [{ code: "invalid-app", severity: "error", at: "app.json", message: `cannot read app.json: ${reason}` }] };
  }
}

/** Where an application's handwritten module is, if it exists: `.ts` or `.tsx`. */
export function extensionFile(dir: string, module: string): string | undefined {
  for (const ext of [".ts", ".tsx"]) {
    const f = path.join(dir, "src", "extensions", `${module}${ext}`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

/**
 * The checker's environment from the application's host (ADR-0080): the
 * model, and the runtime's own answers for each caller (what they are told
 * of the model, which policies admit them) and for each configured model's
 * audience. Every answer is the runtime's; the checker only asks early.
 */
export async function environmentFor(spec: AppSpec, loaded: LoadedHost, dir: string): Promise<{ env: CheckEnvironment; diagnostics: AppDiagnostic[] }> {
  const { host, resolve } = loaded;
  const diagnostics: AppDiagnostic[] = [];
  const identities = new Map<string, Identity>();
  for (const [name, caller] of Object.entries(spec.callers ?? {})) {
    try {
      identities.set(name, await resolve(caller.token === "" ? null : caller.token));
    } catch {
      diagnostics.push({ code: "invalid-caller", severity: "error", at: `/callers/${name}/token`, message: `the host does not resolve caller "${name}"'s token`, hint: "use a token the host's identity resolver accepts, or \"\" for an anonymous caller" });
    }
  }
  const who = (caller: string): Identity => {
    const id = identities.get(caller);
    if (!id) throw new Error(`no identity for caller ${caller}`);
    return id;
  };
  let models: CheckEnvironment["models"];
  if (spec.llm) {
    try {
      const config = JSON.parse(await readFile(path.join(dir, spec.llm), "utf8")) as LlmConfig;
      // Secrets are not needed to know a model's uses and audience: none is read here.
      const resolved = resolveConfig(config, () => undefined);
      models = Object.fromEntries([...resolved.models].map(([id, m]) => [id, { uses: m.uses, audience: m.audience }]));
      for (const c of resolved.diagnostics) if (c.severity === "error") diagnostics.push({ code: "invalid-llm-config", severity: "error", at: "/llm", message: `${spec.llm} ${c.at}: ${c.message}`, ...(c.hint ? { hint: c.hint } : {}) });
    } catch {
      diagnostics.push({ code: "invalid-llm-config", severity: "error", at: "/llm", message: `cannot read the LLM configuration ${spec.llm}`, hint: "a typesys.llm/1 file relative to the application (ADR-0074)" });
    }
  }
  const env: CheckEnvironment = {
    model: await describeModel(host.registry),
    describedTo: async (caller) => host.runtime.describeModel(who(caller)).catch(() => undefined),
    describedToAudience: async (caller, audience) => host.runtime.describeModel(withAudience(who(caller), audience)).catch(() => undefined),
    admits: async (policy, resource, caller) => (await decideForIdentity(host.policyEngine, { subject: who(caller), action: "invoke", policyName: policy, resource })).allow,
    ...(models ? { models } : {}),
    extensionExists: (module) => extensionFile(dir, module) !== undefined
  };
  return { env, diagnostics };
}

/** Reads, loads the host for, and checks the application in `dir`. */
export async function checkAppDir(dir: string, options: LoadHostOptions = {}): Promise<{ analysis?: AppAnalysis; diagnostics: AppDiagnostic[] }> {
  const abs = path.resolve(dir);
  const read = await readAppSpec(abs);
  if (read.doc === undefined) return { diagnostics: read.diagnostics };
  const spec = read.doc as AppSpec;
  if (!spec || typeof spec !== "object" || !spec.host || typeof spec.host !== "object") {
    const analysis = await checkApp(read.doc, { model: { format: "typesys.model/1", types: [], actions: [] } });
    return { analysis, diagnostics: [...analysis.diagnostics] };
  }
  const loaded = await tryLoadHost(spec, abs, options);
  if ("diagnostic" in loaded) return { diagnostics: [loaded.diagnostic] };
  try {
    const { env, diagnostics } = await environmentFor(spec, loaded, abs);
    const analysis = await checkApp(read.doc, env);
    return { analysis, diagnostics: [...diagnostics, ...analysis.diagnostics] };
  } finally {
    await stopHost(loaded);
  }
}

/** A host may start services of its own (the sortie host starts three); they stop when the compiler is done asking. */
export async function stopHost(loaded: LoadedHost): Promise<void> {
  await (loaded.host as { services?: { stop(): Promise<void> } }).services?.stop().catch(() => undefined);
}

/** Everything the compiler writes for a checked application: the files it owns, and the files it writes once. */
export interface Generated {
  /** Rewritten on every compile; a hand edit is reported, never kept silently or overwritten silently. */
  readonly owned: ReadonlyMap<string, string>;
  /** Written only when absent: after that, the developer's. */
  readonly once: ReadonlyMap<string, string>;
}

/**
 * The application's code (ADR-0082), as a pure function of the checked
 * application: the same specification and model give byte-identical files,
 * in a stable order, so a diff of the output is a diff of the meaning.
 */
export function generate(analysis: AppAnalysis): Generated {
  const app = analysis.app;
  const owned = new Map<string, string>();
  const once = new Map<string, string>();
  const flowKeys = Object.keys(analysis.flows).sort();
  owned.set("server.ts", serverSource(app, flowKeys));
  owned.set("index.html", indexHtml(app));
  owned.set("src/generated/model.ts", modelSource(analysis));
  owned.set("src/generated/contracts.ts", contractsSource(analysis));
  owned.set("src/generated/contracts-check.ts", contractsCheckSource(analysis));
  for (const key of flowKeys) owned.set(`src/generated/flows/${key}.ts`, flowSource(analysis.flows[key]!, analysis));
  for (const info of [...analysis.pages].sort((a, b) => a.page.name.localeCompare(b.page.name))) owned.set(`src/generated/pages/${info.page.name}.tsx`, pageSource(info, analysis));
  owned.set("src/generated/app.tsx", appSource(analysis));
  owned.set("src/generated/acceptance.test.ts", acceptanceSource(app));

  once.set("package.json", `${JSON.stringify({ name: app.name, private: true, type: "module", scripts: { build: "typesys-app build .", start: "node dist/server.js", test: "vitest run" } }, null, 2)}\n`);
  once.set("tsconfig.json", `${JSON.stringify(APP_TSCONFIG, null, 2)}\n`);
  once.set(".gitignore", "dist/\n");
  const components = new Set(Object.values(analysis.components).map((c) => c.module));
  const modules = [...new Set([...Object.values(analysis.fns).map((f) => f.module), ...components])].sort();
  for (const m of modules) once.set(`src/extensions/${m}${components.has(m) ? ".tsx" : ".ts"}`, extensionStub(analysis, m));
  if (app.llm) once.set("src/extensions/server.ts", SERVER_EXTENSION);
  return { owned, once };
}

export interface CompileOptions extends LoadHostOptions {
  /** Overwrite generated files edited by hand, instead of stopping at them. */
  readonly force?: boolean;
}

export interface CompileResult {
  readonly ok: boolean;
  readonly diagnostics: readonly AppDiagnostic[];
  /** Generated files whose content changed, in order. */
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** Handwritten files written for the first time. */
  readonly created: readonly string[];
  /** Generated files a previous compile wrote that this one does not (a removed page or flow), deleted. */
  readonly removed: readonly string[];
  readonly analysis?: AppAnalysis;
}

/**
 * Checks and compiles the application in `dir` (ADR-0082, ADR-0083):
 * nothing is written unless the check has no error; a generated file is
 * written only when its content changes; a handwritten file is written only
 * when absent; a generated file edited since the last compile stops the
 * compile, naming it, unless `force`.
 */
export async function compileApp(dir: string, options: CompileOptions = {}): Promise<CompileResult> {
  const abs = path.resolve(dir);
  const none = (diagnostics: readonly AppDiagnostic[], analysis?: AppAnalysis): CompileResult => ({ ok: false, diagnostics, written: [], unchanged: [], created: [], removed: [], ...(analysis ? { analysis } : {}) });
  const checked = await checkAppDir(abs, options);
  if (!checked.analysis || checked.diagnostics.some((d) => d.severity === "error")) return none(checked.diagnostics, checked.analysis);
  const analysis = checked.analysis;
  const { owned, once } = generate(analysis);

  const lock = await readLock(abs);
  const edited: AppDiagnostic[] = [];
  for (const [file, hash] of Object.entries(lock?.files ?? {})) {
    const f = path.join(abs, file);
    if (!existsSync(f)) continue;
    if (sha(await readFile(f, "utf8")) !== hash && !options.force)
      edited.push({ code: "edited-generated-file", severity: "error", at: file, message: `${file} was edited since it was generated`, hint: "move the change to app.json or src/extensions/, or compile with --force to discard it", because: "the compiler owns generated files and would overwrite the edit" });
  }
  if (edited.length) return none([...checked.diagnostics, ...edited], analysis);

  const written: string[] = [];
  const unchanged: string[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  for (const [file, content] of owned) {
    const f = path.join(abs, file);
    if (existsSync(f) && (await readFile(f, "utf8")) === content) {
      unchanged.push(file);
      continue;
    }
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, content);
    written.push(file);
  }
  for (const [file, content] of once) {
    const f = path.join(abs, file);
    if (existsSync(f) || (file.startsWith("src/extensions/") && extensionFile(abs, file.slice("src/extensions/".length).replace(/\.tsx?$/, "")))) continue;
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, content);
    created.push(file);
  }
  for (const file of Object.keys(lock?.files ?? {})) {
    if (owned.has(file)) continue;
    await rm(path.join(abs, file), { force: true });
    removed.push(file);
  }
  const next: AppLock = { format: LOCK_FORMAT, spec: sha(canonical(analysis.app)), files: Object.fromEntries([...owned].map(([f, c]) => [f, sha(c)])) };
  await writeFile(path.join(abs, LOCK_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, diagnostics: checked.diagnostics, written, unchanged, created, removed, analysis };
}

export async function readLock(dir: string): Promise<AppLock | undefined> {
  try {
    const lock = JSON.parse(await readFile(path.join(dir, LOCK_FILE), "utf8")) as AppLock;
    return lock.format === LOCK_FORMAT ? lock : undefined;
  } catch {
    return undefined;
  }
}
