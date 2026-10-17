import { readFile } from "node:fs/promises";
import path from "node:path";
import { compileContext } from "@typesys/devkit";
import { tryLoadHost } from "@typesys/engineer";
import { buildApp } from "./build.js";
import { EFFECT_CATALOG, NODE_BASE, NODE_CATALOG, OP_CATALOG, SCOPES, STEP_BASE, STEP_CATALOG } from "./catalog.js";
import { checkApp } from "./check.js";
import { checkAppDir, compileApp, environmentFor, generate, readAppSpec, stopHost } from "./compile.js";
import { DIAGNOSTIC_CODES, type AppDiagnostic } from "./diagnostics.js";
import { diffApps } from "./diff.js";
import type { AppSpec } from "./ir.js";
import { verifyApp } from "./verify.js";

export const APP_USAGE = `typesys app — the application compiler (ADR-0079 to ADR-0085)

Usage:
  typesys app catalog [--json]
  typesys app explain <code> [--json]
  typesys app context <dir> [--as <caller>] [--max-tokens <n>] [--json]
  typesys app check <dir> [--json]
  typesys app compile <dir> [--force] [--json]
  typesys app build <dir> [--json]
  typesys app verify <dir> [--json]
  typesys app diff <dir> --against <app.json> [--json]

  catalog   Every primitive (nodes, steps, effects, operators, scopes) and
            its fields: the whole language, as data.
  explain   What a diagnostic code means and how to resolve it.
  context   The part of the model <dir>/app.json's requirement needs, as a
            caller is told of it and returned it (ADR-0078): what to write
            the specification against.
  check     Check <dir>/app.json against the host's model and its policies
            as each caller: every problem as {code, severity, at, message,
            hint, because}, at a JSON Pointer into app.json. Exits 1 on an
            error.
  compile   Check, then write the application: src/generated/ and
            server.ts every time their content changes, src/extensions/
            stubs once. Stops at a generated file edited by hand unless
            --force.
  build     tsc over the whole application, and the client bundle.
  verify    Compile, build, and run every acceptance check against a fresh
            copy: API checks through the API, screen checks in Chromium.
  diff      What changed between <app.json> and <dir>/app.json, what each
            change risks, the generated files it changes and the checks
            that exercise it.

--json prints one JSON object for an agent.`;

const line = (d: AppDiagnostic) => `  ${d.severity.padEnd(7)} ${d.code} at ${d.at || "/"}: ${d.message}${d.hint ? ` (${d.hint})` : ""}${d.because ? ` [${d.because}]` : ""}`;

/** The language as data: what `catalog` prints and the MCP tool returns. */
export function catalogDocument() {
  return { format: "typesys.app-catalog/1", nodeBase: NODE_BASE, nodes: NODE_CATALOG, stepBase: STEP_BASE, steps: STEP_CATALOG, effects: EFFECT_CATALOG, operators: OP_CATALOG, scopes: SCOPES };
}

function catalogText(): string {
  const props = (p: Readonly<Record<string, { kind: string; required?: boolean; doc: string; values?: readonly string[] }>>) =>
    Object.entries(p).map(([k, v]) => `    ${k}${v.required ? "" : "?"}: ${v.values ? v.values.join(" | ") : v.kind}  ${v.doc}`);
  return [
    "Nodes (interface). Every node also takes:",
    ...props(NODE_BASE),
    ...Object.entries(NODE_CATALOG).flatMap(([k, s]) => [`  ${k}: ${s.doc}`, ...props(s.props)]),
    "",
    "Steps (flows). Every step also takes:",
    ...props(STEP_BASE),
    ...Object.entries(STEP_CATALOG).flatMap(([k, s]) => [`  ${k}: ${s.doc}`, ...props(s.props)]),
    "",
    "Effects:",
    ...Object.entries(EFFECT_CATALOG).map(([k, v]) => `  ${k}: ${v}`),
    "",
    "Operators ({ \"op\": operands }; unknown in, unknown out; a condition acts only when true):",
    ...Object.entries(OP_CATALOG).map(([k, v]) => `  ${k}: ${v}`),
    "",
    "References:",
    ...Object.entries(SCOPES).map(([k, v]) => `  ${k}: ${v}`)
  ].join("\n");
}

function arg(rest: readonly string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

export interface AppCommandOptions {
  /** Host modules given as paths must be inside this directory, as the MCP tools require. */
  readonly within?: string;
}

/** Runs `typesys app <args>`; returns the exit code. */
export async function appCommand(argv: readonly string[], out: (s: string) => void = console.log, options: AppCommandOptions = {}): Promise<number> {
  const [sub, target, ...rest] = argv;
  const json = argv.includes("--json");
  const print = (ok: boolean, payload: unknown, lines: readonly string[]) => {
    out(json ? JSON.stringify(payload) : lines.join("\n"));
    return ok ? 0 : 1;
  };
  const host = options.within === undefined ? {} : { within: options.within };

  if (sub === "catalog") return print(true, catalogDocument(), [catalogText()]);
  if (sub === "explain") {
    const entry = target ? DIAGNOSTIC_CODES[target] : undefined;
    if (!target || !entry) return print(false, { ok: false, codes: Object.keys(DIAGNOSTIC_CODES) }, [`Codes: ${Object.keys(DIAGNOSTIC_CODES).join(", ")}`]);
    return print(true, { code: target, ...entry }, [`${target}: ${entry.meaning}`, `  resolve: ${entry.resolve}`]);
  }
  if (!target || target.startsWith("--")) {
    out(APP_USAGE);
    return 1;
  }

  switch (sub) {
    case "check": {
      const r = await checkAppDir(target, host);
      const errors = r.diagnostics.filter((d) => d.severity === "error").length;
      const a = r.analysis;
      const summary = a
        ? [
            ...Object.values(a.flows).map((f) => `  flow ${f.flow.name} ${f.flow.version}: ${f.flow.steps.length} steps${f.admitted ? `, started by ${f.admitted.start.join(", ") || "nobody"}` : ""}`),
            ...a.pages.map((p) => `  page ${p.page.name} ${p.page.path}: ${Object.keys(p.data).length} data`),
            `  ${a.app.acceptance.length} acceptance checks`
          ]
        : [];
      return print(errors === 0, { ok: errors === 0, diagnostics: r.diagnostics, ...(a ? { flows: Object.fromEntries(Object.entries(a.flows).map(([k, f]) => [k, { name: f.flow.name, admitted: f.admitted, reads: f.reads, writes: f.writes }])), actions: a.actions } : {}) }, [
        `${errors === 0 ? "OK" : "INVALID"} — ${a?.app.name ?? target}`,
        ...summary,
        ...r.diagnostics.map(line)
      ]);
    }
    case "compile": {
      const r = await compileApp(target, { ...host, force: rest.includes("--force") });
      return print(r.ok, { ok: r.ok, diagnostics: r.diagnostics, written: r.written, unchanged: r.unchanged, created: r.created, removed: r.removed }, [
        `${r.ok ? "OK" : "NOT COMPILED"} — ${r.analysis?.app.name ?? target}`,
        ...r.written.map((f) => `  wrote   ${f}`),
        ...r.created.map((f) => `  created ${f} (yours from now on)`),
        ...r.removed.map((f) => `  removed ${f}`),
        ...(r.ok ? [`  ${r.unchanged.length} unchanged`] : []),
        ...r.diagnostics.map(line)
      ]);
    }
    case "build": {
      const d = await buildApp(target);
      return print(d.length === 0, { ok: d.length === 0, diagnostics: d }, [d.length === 0 ? `OK — built ${target}/dist` : "BUILD FAILED", ...d.map(line)]);
    }
    case "verify": {
      const r = await verifyApp(target, host);
      const stages = Object.entries(r.stages).map(([s, ok]) => `${s} ${ok ? "ok" : "FAILED"}`).join(", ");
      return print(r.ok, r, [`${r.ok ? "OK" : "FAILED"} — ${r.app || target}: ${stages}`, ...r.checks.map((c) => `  ${c.ok ? "pass" : "FAIL"}  ${c.id}`), ...r.diagnostics.map(line)]);
    }
    case "diff":
      return diffCommand(target, arg(rest, "--against"), print, host);
    case "context":
      return contextCommand(target, rest, print, host);
    default:
      out(APP_USAGE);
      return 1;
  }
}

type Print = (ok: boolean, payload: unknown, lines: readonly string[]) => number;

async function diffCommand(dir: string, against: string | undefined, print: Print, host: { within?: string }): Promise<number> {
  if (!against) return print(false, { ok: false, error: "--against <app.json> is required" }, ["diff needs --against <app.json>: the version to compare with"]);
  const now = await readAppSpec(path.resolve(dir));
  let before: unknown;
  try {
    before = JSON.parse(await readFile(against, "utf8"));
  } catch {
    return print(false, { ok: false, error: `cannot read ${against}` }, [`cannot read ${against}`]);
  }
  if (now.doc === undefined) return print(false, { ok: false, diagnostics: now.diagnostics }, now.diagnostics.map(line));
  const after = now.doc as AppSpec;
  // Both versions generated against the same model: the files that change are exactly those whose content differs.
  let generated: Parameters<typeof diffApps>[2];
  const loaded = await tryLoadHost(after, path.resolve(dir), host);
  if (!("diagnostic" in loaded)) {
    try {
      const { env } = await environmentFor(after, loaded, path.resolve(dir));
      const [a, b] = await Promise.all([checkApp(before, env), checkApp(after, env)]);
      if (a.ok && b.ok) generated = { before: generate(a), after: generate(b) };
    } finally {
      await stopHost(loaded);
    }
  }
  const d = diffApps(before as AppSpec, after, generated);
  return print(true, { ok: true, ...d }, [
    `${d.changes.length} change${d.changes.length === 1 ? "" : "s"}`,
    ...d.summary.map((s) => `  ${s}`),
    ...(d.impact.files.length ? ["Files:", ...d.impact.files.map((f) => `  ${f}`)] : generated ? [] : ["Files: not computed (one version does not check)"]),
    ...(d.impact.checks.length ? [`Checks to run first: ${d.impact.checks.join(", ")}`] : [])
  ]);
}

async function contextCommand(dir: string, rest: readonly string[], print: Print, host: { within?: string }): Promise<number> {
  const read = await readAppSpec(path.resolve(dir));
  if (read.doc === undefined) return print(false, { ok: false, diagnostics: read.diagnostics }, read.diagnostics.map(line));
  const spec = read.doc as AppSpec;
  const as = arg(rest, "--as") ?? Object.entries(spec.callers ?? {}).find(([, c]) => c.token !== "")?.[0];
  const caller = as ? spec.callers?.[as] : undefined;
  if (!as || !caller) return print(false, { ok: false, error: `no caller ${as ?? ""}` }, [`no caller "${as ?? ""}": callers are ${Object.keys(spec.callers ?? {}).join(", ")}`]);
  const loaded = await tryLoadHost(spec, path.resolve(dir), host);
  if ("diagnostic" in loaded) return print(false, { ok: false, diagnostics: [loaded.diagnostic] }, [line(loaded.diagnostic)]);
  try {
    const identity = await loaded.resolve(caller.token === "" ? null : caller.token);
    const maxTokens = Number(arg(rest, "--max-tokens") ?? 4000);
    const ctx = await compileContext(loaded.host.runtime, identity, { task: spec.requirement, maxTokens: Number.isFinite(maxTokens) ? maxTokens : 4000 });
    return print(true, { ok: true, ...ctx }, [ctx.text, "", `${ctx.tokens} tokens as ${as}${ctx.omitted.length ? `; left out: ${ctx.omitted.join(", ")}` : ""}`]);
  } finally {
    await stopHost(loaded);
  }
}
