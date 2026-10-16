import { readFile } from "node:fs/promises";
import path from "node:path";
import { tryLoadHost } from "./host.js";
import { parseMission, type EngineerDiagnostic, type MissionSpec } from "./mission.js";
import { planMission } from "./plan.js";
import { scaffoldMission } from "./scaffold.js";
import { verifyMission } from "./verify.js";
import { writeFile } from "node:fs/promises";
import { answeringModel, createLlm, loadLlmConfig, requestText, type LanguageModel } from "@typesys/llm";
import { insideRoot } from "@typesys/devkit";
import { BRIEF_FORMAT, draftMission, type MissionBrief } from "./draft.js";

export const ENGINEER_USAGE = `typesys engineer — the engineering loop (ADR-0071)

Usage:
  typesys engineer plan <mission.json> [--json]
  typesys engineer scaffold <mission.json> --out <dir> [--json]
  typesys engineer verify <dir> [--json]
  typesys engineer draft <brief.json> --out <mission.json> [--answer <answer.json>]... [--feedback <file>]... [--model <id> [--llm-config <file>]] [--json]

  plan      What the model already provides for the mission, what the
            application must add, and every problem with the spec, each
            with a code and a fix. Exits 1 on an error.
  scaffold  Plan, then write the application into <dir>: mission.json,
            model.ts, workflow.ts, views.tsx, server.ts and
            acceptance.test.ts. Refuses a spec whose plan has an error.
  verify    Plan the mission in <dir>/mission.json, build the application
            there, start it, and run every acceptance check through its
            API as the caller each names. Exits 1 unless every stage
            passes. Whatever is in <dir> is verified, generated or edited.

  draft     Draft a mission spec from a brief: a requirement in words,
            the host, the callers and the policy rules a workflow may
            name (ADR-0077). A development model writes the rest from the
            model context compiled for the brief's author; every answer is
            planned, and its errors are sent back until none is left.
            With --answer, the model is the coding agent you are working
            with: give its answers in order; when another is needed the
            request is written to <mission>.request.txt (exit 2). The
            draft is a proposal: review its acceptance checks before
            scaffold. --feedback sends what verify or a reviewer said
            about a clean draft back to the model, one round each.

--json prints one JSON object (the plan, or the report) for an agent.`;

const line = (d: EngineerDiagnostic) => `  ${d.severity.padEnd(7)} ${d.code} at ${d.at}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`;

async function readSpec(file: string): Promise<{ spec: MissionSpec } | { diagnostics: EngineerDiagnostic[] }> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    return { diagnostics: [{ code: "invalid-mission", severity: "error", at: file, message: `cannot read the mission: ${(err as Error).message}` }] };
  }
  const parsed = parseMission(doc);
  return parsed.spec ? { spec: parsed.spec } : { diagnostics: parsed.diagnostics };
}

export interface EngineerCommandOptions {
  /**
   * Confine what `draft` loads and writes to this directory, as the MCP
   * tools are: a host module that is a path or a specifier climbing out
   * with `..` is refused, and so is every file it would write that is, or
   * leads through a symlink to, a place outside.
   */
  readonly within?: string;
}

/** Runs `typesys engineer <args>`; returns the exit code. */
export async function engineerCommand(argv: readonly string[], out: (s: string) => void = console.log, options: EngineerCommandOptions = {}): Promise<number> {
  const [sub, target, ...rest] = argv;
  const json = rest.includes("--json") || argv.includes("--json");
  const outIndex = rest.indexOf("--out");
  const outDir = outIndex >= 0 ? rest[outIndex + 1] : undefined;
  if (sub === "draft" && target && !target.startsWith("--") && outDir) return draftCommand(target, outDir, rest, json, out, options.within);
  if (!target || target.startsWith("--") || !(sub === "plan" || sub === "scaffold" || sub === "verify") || (sub === "scaffold" && !outDir)) {
    out(ENGINEER_USAGE);
    return 1;
  }
  const print = (ok: boolean, payload: unknown, lines: string[]) => {
    out(json ? JSON.stringify(payload) : lines.join("\n"));
    return ok ? 0 : 1;
  };

  if (sub === "verify") {
    const report = await verifyMission(target);
    const stages = Object.entries(report.stages).map(([s, ok]) => `${s} ${ok ? "ok" : "FAILED"}`).join(", ");
    return print(report.ok, report, [
      `${report.ok ? "OK" : "FAILED"} — ${report.mission || target}: ${stages}`,
      ...report.checks.map((c) => `  ${c.ok ? "pass" : "FAIL"}  ${c.id}`),
      ...report.diagnostics.map(line)
    ]);
  }

  const read = await readSpec(target);
  if (!("spec" in read)) return print(false, { ok: false, diagnostics: read.diagnostics }, ["INVALID mission", ...read.diagnostics.map(line)]);
  const loaded = await tryLoadHost(read.spec, path.dirname(path.resolve(target)));
  if ("diagnostic" in loaded) return print(false, { ok: false, diagnostics: [loaded.diagnostic] }, ["INVALID mission", line(loaded.diagnostic)]);
  try {
    const { host, resolve, workflows } = loaded;
    const plan = await planMission(read.spec, host, resolve, workflows);
    const planLines = [
      `${plan.ok ? "OK" : "INVALID"} — ${plan.mission}`,
      ...plan.provided.types.map((t) => `  provides Type   ${t.name} (described to ${t.describedTo.join(", ") || "no caller"})`),
      ...plan.provided.relationships.map((r) => `  provides relationship ${r.from}.${r.name} → ${r.target} (${r.cardinality})`),
      ...plan.provided.actions.map((a) => `  provides Action ${a.name} (described to ${a.describedTo.join(", ") || "no caller"})`),
      ...plan.provided.workflows.map((w) => `  provides workflow ${w.name} ${w.version}`),
      ...plan.create.map((f) => `  creates  ${f.file}: ${f.detail}`),
      ...plan.diagnostics.map(line)
    ];
    if (sub === "plan") return print(plan.ok, plan, planLines);
    if (!plan.ok) return print(false, { ok: false, plan, files: [] }, [...planLines, "Nothing written: fix the errors above first."]);
    const files = await scaffoldMission(read.spec, host, outDir!);
    return print(true, { ok: true, plan, dir: outDir, files }, [...planLines, `Wrote ${files.length} files to ${outDir}; next: typesys engineer verify ${outDir}`]);
  } finally {
    // A host may start services of its own (the sortie host starts three); they go with the command.
    await (loaded.host as { services?: { stop(): Promise<void> } }).services?.stop().catch(() => undefined);
  }
}

async function draftCommand(briefFile: string, outFile: string, rest: readonly string[], json: boolean, out: (s: string) => void, within?: string): Promise<number> {
  const writeTo = (file: string, text: string) => writeFile(within === undefined ? file : insideRoot(within, file), text, "utf8");
  const print = (code: number, payload: unknown, lines: string[]) => {
    out(json ? JSON.stringify(payload) : lines.join("\n"));
    return code;
  };
  let brief: MissionBrief;
  try {
    brief = JSON.parse(await readFile(briefFile, "utf8")) as MissionBrief;
    if (brief.format !== BRIEF_FORMAT) throw new Error(`it is not ${String(BRIEF_FORMAT)}`);
  } catch (err) {
    return print(1, { ok: false, error: (err as Error).message }, [`INVALID brief — ${(err as Error).message}`]);
  }
  const loaded = await tryLoadHost({ host: brief.host }, path.dirname(path.resolve(briefFile)), within === undefined ? {} : { within });
  if ("diagnostic" in loaded) return print(1, { ok: false, diagnostics: [loaded.diagnostic] }, ["INVALID brief", line(loaded.diagnostic)]);
  try {
    return await draftWith(loaded, brief, outFile, rest, json, print, writeTo);
  } finally {
    // A host may start services of its own (the sortie host starts three); they go with the command.
    await (loaded.host as { services?: { stop(): Promise<void> } }).services?.stop().catch(() => undefined);
  }
}

async function draftWith(
  loaded: Exclude<Awaited<ReturnType<typeof tryLoadHost>>, { diagnostic: unknown }>,
  brief: MissionBrief,
  outFile: string,
  rest: readonly string[],
  json: boolean,
  print: (code: number, payload: unknown, lines: string[]) => number,
  writeTo: (file: string, text: string) => Promise<void>
): Promise<number> {
  const flag = (name: string) => rest.flatMap((v, i) => (rest[i - 1] === name ? [v] : []));
  const base = outFile.replace(/\.json$/, "");
  let lm: LanguageModel;
  let recordings: unknown[] | undefined;
  let needed: (() => unknown) | undefined;
  const answers = flag("--answer");
  if (answers.length || !flag("--model").length) {
    const agent = answeringModel(await Promise.all(answers.map(async (f) => JSON.parse(await readFile(f, "utf8")) as unknown)), "a coding agent acting as the development model (agent mode)", brief.agentAudience ? { audience: brief.agentAudience } : {});
    lm = agent.model;
    recordings = agent.recordings;
    needed = agent.needed;
  } else {
    const config = await loadLlmConfig(flag("--llm-config")[0]);
    if (!config) return print(1, { ok: false, error: "no model configuration" }, ["--model needs a model configuration: --llm-config, TYPESYS_LLM_CONFIG or typesys.llm.json"]);
    lm = createLlm(config).model(flag("--model")[0]!, "development");
  }
  try {
    const feedback = await Promise.all(flag("--feedback").map((f) => readFile(f, "utf8")));
    const result = await draftMission(brief, loaded, lm, { feedback });
    if (result.spec) await writeTo(outFile, `${JSON.stringify(result.spec, null, 2)}\n`);
    await writeTo(`${base}.draft.json`, `${JSON.stringify({ ok: result.ok, rounds: result.rounds, context: { tokens: result.context.tokens, types: result.context.types.map((t) => t.name), actions: result.context.actions.map((a) => a.name), digest: result.context.digest }, ...(recordings ? { recordings } : {}) }, null, 2)}\n`);
    const last = result.rounds.at(-1);
    return print(result.ok ? 0 : 1, { ok: result.ok, rounds: result.rounds.length, diagnostics: last?.diagnostics ?? [], out: outFile }, [
      `${result.ok ? "DRAFTED" : "NOT READY"} — ${result.spec?.name ?? "(no spec)"} in ${result.rounds.length} round${result.rounds.length === 1 ? "" : "s"}; review its acceptance checks, then: typesys engineer scaffold ${outFile} --out <dir>`,
      ...result.rounds.map((r, i) => `  round ${i + 1}: ${r.diagnostics.filter((d) => d.severity === "error").length} errors`),
      ...(last?.diagnostics ?? []).map(line)
    ]);
  } catch (err) {
    const request = needed?.() as Parameters<typeof requestText>[0] | undefined;
    if (!request) throw err;
    await writeTo(`${base}.request.txt`, `${requestText(request)}\n`);
    return print(2, { ok: false, answerNeeded: `${base}.request.txt`, answered: answers.length }, [`The coding agent's answer ${answers.length + 1} is needed: the request is in ${base}.request.txt. Write the answer as JSON and run again with one more --answer.`]);
  }
}
