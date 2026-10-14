import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadHost } from "./host.js";
import { parseMission, type EngineerDiagnostic, type MissionSpec } from "./mission.js";
import { planMission } from "./plan.js";
import { scaffoldMission } from "./scaffold.js";
import { verifyMission } from "./verify.js";

export const ENGINEER_USAGE = `typesys engineer — the engineering loop (ADR-0071)

Usage:
  typesys engineer plan <mission.json> [--json]
  typesys engineer scaffold <mission.json> --out <dir> [--json]
  typesys engineer verify <dir> [--json]

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

/** Runs `typesys engineer <args>`; returns the exit code. */
export async function engineerCommand(argv: readonly string[], out: (s: string) => void = console.log): Promise<number> {
  const [sub, target, ...rest] = argv;
  const json = rest.includes("--json") || argv.includes("--json");
  const outIndex = rest.indexOf("--out");
  const outDir = outIndex >= 0 ? rest[outIndex + 1] : undefined;
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
  const { host, resolve, workflows } = await loadHost(read.spec, path.dirname(path.resolve(target)));
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
}
