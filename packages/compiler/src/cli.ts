import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BASELINE_FORMAT, analyzeChange, compileContext, governedGraph, isBaseline, probeLinks, queryGraph, recordBaseline, renderImpact, renderLinks, GRAPH_VIEWS, type GraphViewName } from "@typesys/devkit";
import { describeModel, type ExplainQuestion, type Identity } from "@typesys/core";
import { tryLoadHost } from "@typesys/engineer";
import { buildApp } from "./build.js";
import { EFFECT_CATALOG, NODE_BASE, NODE_CATALOG, OP_CATALOG, SCOPES, STEP_BASE, STEP_CATALOG } from "./catalog.js";
import { checkApp } from "./check.js";
import { checkAppDir, compileApp, environmentFor, generate, readAppSpec, stopHost } from "./compile.js";
import { DIAGNOSTIC_CODES, type AppDiagnostic } from "./diagnostics.js";
import { diffApps } from "./diff.js";
import { missionToApp } from "./migrate.js";
import type { AppSpec } from "./ir.js";
import { verifyApp } from "./verify.js";
import { appUses } from "./uses.js";

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
  typesys app migrate <mission.json> --out <dir> [--force] [--json]
  typesys app inspect <dir> [--as <caller>] [--type <Type>]... [--json]
  typesys app why <dir> [--as <caller>] [--for <caller>] (--read <Type>/<id> | --related <Type>/<id>/<relationship> | --invoke <Action> [--input <json>] | --query <json>) [--json]
  typesys app graph <dir> [--as <caller>] [--view overview|neighborhood|dependents|dependencies|full] [--node <id>] [--depth <n>] [--json]
  typesys app impact <dir> [--as <caller>] (--record <baseline.json> | --against <baseline.json>) [--json]
  typesys app links <dir> [--as <caller>] [--for <caller>] [--type <Type>]... [--cross-source] [--json]

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
  inspect   Where each value comes from and what guards it: sources,
            policies with their rules, markings, derivations (ADR-0088).
            Only for a caller the host's inspection policy admits.
  why       Why the runtime allows, partly answers, refuses or cannot
            answer a read, relationship, Action or query (ADR-0089), for
            --as, or with --for for another caller (an inspector only).
  graph     The dependency graph of the model and this application, as
            --as may learn it (ADR-0090): what a change to --node reaches
            (dependents) or what it rests on (dependencies).
  impact    What a change to the model does (ADR-0093). --record writes a
            baseline: the model, its inspection when --as may inspect, and
            how each caller's read of a few objects is decided, with no
            values. --against records the host as it is now and compares:
            contract and governance changes, every read whose decision
            changed, and the consumers and checks each change reaches.
            Exits 1 on a breaking change, an under-versioned one, or a read
            a caller is newly returned.
  links     Each relationship probed on a few objects (ADR-0094): which
            cross into another system, how many related objects are
            returned, and how many resolutions a source did not answer.
            With --for (an inspector only), also references that dangle
            or are refused to that caller. Exits 1 on a dangling one.
  migrate   Translate a typesys.mission/1 spec into <dir>/app.json: the
            same host, callers and checks, the workflow step for step, the
            views as tables. Every change it makes is a mission-translation
            note. Then compile <dir>.

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
    case "migrate":
      return migrateCommand(target, arg(rest, "--out"), rest.includes("--force"), print, options.within);
    case "inspect":
    case "why":
    case "graph":
    case "impact":
    case "links":
      return workbenchCommand(sub, target, rest, print, host);
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
    // What the application is built from is part of the context: its pages, data and checks are listed with the Types they use (ADR-0092).
    const consumers = appUses(spec, await describeModel(loaded.host.registry));
    const ctx = await compileContext(loaded.host.runtime, identity, { task: spec.requirement, maxTokens: Number.isFinite(maxTokens) ? maxTokens : 4000, consumers });
    return print(true, { ok: true, ...ctx }, [ctx.text, "", `${ctx.tokens} tokens as ${as}${ctx.leftOut.length ? `; left out: ${ctx.leftOut.map((l) => (l.reason === "budget" ? l.name : `${l.name} (${l.reason})`)).join(", ")}` : ""}`]);
  } finally {
    await stopHost(loaded);
  }
}

function args(rest: readonly string[], flag: string): string[] {
  return rest.flatMap((v, i) => (rest[i - 1] === flag ? [v] : []));
}

/** The question `why` asks, from its flags. */
function question(rest: readonly string[]): ExplainQuestion | string {
  const read = arg(rest, "--read");
  const related = arg(rest, "--related");
  const invoke = arg(rest, "--invoke");
  const query = arg(rest, "--query");
  const parse = (text: string | undefined, what: string): unknown => {
    try {
      return JSON.parse(text ?? "{}") as unknown;
    } catch {
      throw new Error(`${what} is not JSON`);
    }
  };
  if (read) {
    const [type, ...id] = read.split("/");
    return type && id.length ? { kind: "read", type, id: id.join("/") } : "--read takes <Type>/<id>";
  }
  if (related) {
    const parts = related.split("/");
    return parts.length >= 3 ? { kind: "relationship", type: parts[0]!, id: parts.slice(1, -1).join("/"), relationship: parts.at(-1)! } : "--related takes <Type>/<id>/<relationship>";
  }
  if (invoke) return { kind: "invoke", action: invoke, input: parse(arg(rest, "--input"), "--input") };
  if (query) return { kind: "query", query: parse(query, "--query") as never };
  return "why needs one of --read, --related, --invoke, --query";
}

/** inspect, why, graph, impact and links: each a question one of the application's callers asks the host's runtime, which decides it. */
async function workbenchCommand(sub: "inspect" | "why" | "graph" | "impact" | "links", dir: string, rest: readonly string[], print: Print, host: { within?: string }): Promise<number> {
  const read = await readAppSpec(path.resolve(dir));
  if (read.doc === undefined) return print(false, { ok: false, diagnostics: read.diagnostics }, read.diagnostics.map(line));
  const spec = read.doc as AppSpec;
  const callerNamed = (name: string | undefined) => (name ? spec.callers?.[name] : undefined);
  const as = arg(rest, "--as") ?? Object.entries(spec.callers ?? {}).find(([, c]) => c.token !== "")?.[0];
  if (!as || !callerNamed(as)) return print(false, { ok: false, error: `no caller ${as ?? ""}` }, [`no caller "${as ?? ""}": callers are ${Object.keys(spec.callers ?? {}).join(", ")}`]);
  const forName = arg(rest, "--for");
  if (forName !== undefined && !callerNamed(forName)) return print(false, { ok: false, error: `no caller ${forName}` }, [`no caller "${forName}": callers are ${Object.keys(spec.callers ?? {}).join(", ")}`]);
  const loaded = await tryLoadHost(spec, path.resolve(dir), host);
  if ("diagnostic" in loaded) return print(false, { ok: false, diagnostics: [loaded.diagnostic] }, [line(loaded.diagnostic)]);
  const identityOf = async (name: string): Promise<Identity> => {
    const token = callerNamed(name)!.token;
    return loaded.resolve(token === "" ? null : token);
  };
  const runtime = loaded.host.runtime;
  try {
    const identity = await identityOf(as);
    if (sub === "inspect") {
      const types = args(rest, "--type");
      const i = await runtime.inspectModel(identity, types.length ? { types } : {});
      return print(true, { ok: true, ...i }, [
        `Inspection as ${as} (${i.modelDigest})`,
        ...i.types.flatMap((t) => [
          `${t.name}  object policy ${t.objectPolicy}${t.source ? `, from ${t.source.dataSourceId}` : ""}${t.markings.length ? ` [${t.markings.join(", ")}]` : ""}`,
          ...t.members.map(
            (m) =>
              `  ${m.name}: ${m.computed ? `computed from ${m.computed.dependsOn.join(", ") || "nothing"}${m.computed.releases.length ? `, released from ${m.computed.releases.join(", ")}` : ""}` : (m.source?.dataSourceId ?? "")}${m.policy ? `; policy ${m.policy}` : ""}${m.markings.length ? ` [${m.markings.join(", ")}]` : ""}`
          )
        ]),
        ...i.policies.map((p) => `policy ${p.name}: ${p.rule ?? "opaque"}`)
      ]);
    }
    if (sub === "why") {
      const q = question(rest);
      if (typeof q === "string") return print(false, { ok: false, error: q }, [q]);
      const e = await runtime.explain(q, identity, forName ? { as: await identityOf(forName) } : {});
      return print(true, { ok: true, ...e }, [
        `${e.outcome.toUpperCase()}: ${e.summary}`,
        ...e.findings.map((f) => `  ${f.outcome.padEnd(9)} ${(f.member ?? f.about).padEnd(28)} ${f.basis}${f.control ? `, ${f.control}` : ""}${f.policy ? ` ${f.policy}` : ""}${f.reason ? `: ${f.reason}` : ""}${f.remedy ? ` (to change: ${f.remedy})` : ""}`),
        e.caveat
      ]);
    }
    if (sub === "links") {
      const types = args(rest, "--type");
      const probe = await probeLinks(runtime, identity, { ...(forName ? { as: await identityOf(forName) } : {}), ...(types.length ? { types } : {}), crossSourceOnly: rest.includes("--cross-source") });
      const ok = probe.relationships.every((r) => !r.dangling);
      return print(ok, { ok, ...probe }, renderLinks(probe));
    }
    if (sub === "impact") {
      const [record, against] = [arg(rest, "--record"), arg(rest, "--against")];
      if (!record === !against) return print(false, { ok: false, error: "impact needs one of --record or --against" }, ["impact needs one of --record <baseline.json> or --against <baseline.json>"]);
      const callers = Object.fromEntries(await Promise.all(Object.keys(spec.callers ?? {}).map(async (name) => [name, await identityOf(name)] as const)));
      // Beside the first object of each Type, every object the application's checks name: those are the ones its policies treat differently.
      const named = (spec.acceptance ?? []).flatMap((c) => ("objectId" in c && "type" in c && typeof c.objectId === "string" && typeof c.type === "string" ? [{ type: c.type, id: c.objectId }] : []));
      const objects = named.filter((o, i) => named.findIndex((x) => x.type === o.type && x.id === o.id) === i);
      const now = await recordBaseline(runtime, identity, { callers, objects });
      if (record) {
        await writeFile(path.resolve(record), `${JSON.stringify(now, null, 2)}\n`);
        return print(true, { ok: true, baseline: record, probes: now.probes.length, inspected: now.inspection !== undefined }, [
          `Recorded ${record}: ${now.description.types.length} Types, ${now.probes.length} reads by ${Object.keys(callers).length} callers${now.inspection ? ", with the inspection" : `; ${as} may not inspect, so governance will not be compared`}`
        ]);
      }
      const before: unknown = JSON.parse(await readFile(path.resolve(against!), "utf8"));
      if (!isBaseline(before)) return print(false, { ok: false, error: `${against} is not a ${BASELINE_FORMAT}` }, [`${against} is not a ${BASELINE_FORMAT}`]);
      const impact = analyzeChange(before, now, appUses(spec, await describeModel(loaded.host.registry)));
      const ok = impact.verdict !== "breaking" && impact.exposures.length === 0 && impact.underVersioned.length === 0;
      return print(ok, { ok, ...impact }, renderImpact(impact));
    }
    const view = arg(rest, "--view") ?? "overview";
    if (!(GRAPH_VIEWS as readonly string[]).includes(view)) return print(false, { ok: false, error: `--view is one of ${GRAPH_VIEWS.join(", ")}` }, [`--view is one of ${GRAPH_VIEWS.join(", ")}`]);
    const graph = await governedGraph(runtime, identity, appUses(spec, await describeModel(loaded.host.registry)));
    const node = arg(rest, "--node");
    if (view !== "overview" && view !== "full" && !graph.nodes.some((n) => n.id === node)) return print(false, { ok: false, error: `no node ${node ?? ""}` }, [`no node "${node ?? ""}" in the graph ${as} may see`]);
    const depth = arg(rest, "--depth");
    const r = queryGraph(graph, { view: view as GraphViewName, ...(node ? { node } : {}), ...(depth ? { depth: Number(depth) } : {}) });
    const reached = (r as { reached?: { id: string; via: string; distance: number }[] }).reached;
    return print(true, { ok: true, ...r }, [
      `${graph.structure === "inspection" ? "Graph from an inspection" : "Graph from the description"} as ${as}: ${graph.nodes.length} nodes, ${graph.edges.length} edges (${graph.digest.slice(0, 19)})`,
      ...(reached ? [...reached.map((x) => `  ${"  ".repeat(Math.max(0, x.distance - 1))}${x.id}  (${x.via})`), `Consumers: ${((r as { consumers?: string[] }).consumers ?? []).join(", ") || "none"}`] : ((r as { nodes?: { id: string }[] }).nodes ?? []).map((n) => `  ${n.id}`))
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return print(false, { ok: false, error: message }, [message]);
  } finally {
    await stopHost(loaded);
  }
}

async function migrateCommand(file: string, out: string | undefined, force: boolean, print: Print, within: string | undefined): Promise<number> {
  if (!out) return print(false, { ok: false, error: "--out <dir> is required" }, ["migrate needs --out <dir>: where app.json is written"]);
  const inside = (p: string) => within === undefined || !path.relative(within, path.resolve(within, p)).startsWith("..");
  if (!inside(file) || !inside(out)) return print(false, { ok: false, error: "a path is outside the root" }, ["a path is outside the root"]);
  const source = within === undefined ? path.resolve(file) : path.resolve(within, file);
  const dir = within === undefined ? path.resolve(out) : path.resolve(within, out);
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(source, "utf8"));
  } catch {
    return print(false, { ok: false, error: `cannot read ${file}` }, [`cannot read ${file} as JSON`]);
  }
  const r = missionToApp(doc);
  if (!r.spec) return print(false, { ok: false, diagnostics: r.diagnostics }, ["NOT MIGRATED", ...r.diagnostics.map(line)]);
  const target = path.join(dir, "app.json");
  if (existsSync(target) && !force) return print(false, { ok: false, error: `${target} exists` }, [`${target} exists: pass --force to replace it`]);
  // A host module given as a path is relative to the mission; keep it pointing at the same file from the application.
  const mod = r.spec.host.module;
  const spec = mod.startsWith(".") ? { ...r.spec, host: { ...r.spec.host, module: rel(dir, path.resolve(path.dirname(source), mod)) } } : r.spec;
  await mkdir(dir, { recursive: true });
  await writeFile(target, `${JSON.stringify(spec, null, 2)}\n`);
  return print(true, { ok: true, app: target, diagnostics: r.diagnostics }, [`OK — wrote ${target}`, ...r.diagnostics.map(line), `next: typesys app verify ${out}`]);
}

const rel = (from: string, to: string) => {
  const r = path.relative(from, to).split(path.sep).join("/");
  return r.startsWith(".") ? r : `./${r}`;
};
