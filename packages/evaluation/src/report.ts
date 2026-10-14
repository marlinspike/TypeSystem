import { ARMS } from "./arms.js";
import type { ArmId, RunScore } from "./types.js";

const ARM_ORDER: readonly ArmId[] = ["conventional", "agent-without", "agent-with"];
const pct = (n: number, d: number) => (d === 0 ? "–" : `${Math.round((n / d) * 100)}%`);
const fmt = (v: number | undefined, unit = "") => (v === undefined ? "not measured" : `${v.toLocaleString("en-US")}${unit}`);

/** Imports the arm was not given: a workspace package it does not list, or code reached by a path outside the application. */
export function violations(score: RunScore): string[] {
  const allowed = new Set(ARMS[score.arm].packages);
  // Any workspace package the arm does not list, and any import by a path that leaves the application (P3-V3).
  return (score.code?.imports ?? []).filter((i) => i.endsWith(" (by path)") || (i.startsWith("@typesys/") && !allowed.has(i)));
}

/**
 * The evaluation report: every run, every measure, and every loss, with
 * the checks that decided it. Nothing is averaged away: a cell with three
 * runs lists three rows.
 */
export function renderReport(scores: readonly RunScore[], notes: { contamination?: Record<string, string[]>; notRun?: string[]; tasks?: readonly string[] } = {}): string {
  const out: string[] = ["# Three-arm evaluation: results", ""];
  const tasks = [...new Set([...(notes.tasks ?? []), ...scores.map((s) => s.task)])].sort();
  if (notes.notRun?.length) out.push("Not run:", "", ...notes.notRun.map((n) => `- ${n}`), "");

  for (const task of tasks) {
    out.push(`## ${task}`, "");
    out.push("| Arm | Producer | Hidden checks | Built | Wall time | Tokens (in/out/cache read/cache write) | Cost | Interventions | Code lines | Files | Branches /100 lines | Direct service calls | Restated access rules | p50 / p95 ms | Off-arm imports |");
    out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const arm of ARM_ORDER) {
      const runs = scores.filter((x) => x.task === task && x.arm === arm);
      // An arm with no run is shown as not run, never left out (P3-V5).
      if (runs.length === 0) out.push(`| ${arm} | not run | – | – | – | – | – | – | – | – | – | – | – | – | – |`);
      for (const s of runs) {
        const t = s.production.tokens;
        out.push(
          `| ${arm} | ${s.production.producer} (${s.production.source}) | ${s.passed}/${s.total} (${pct(s.passed, s.total)}) | ${s.built ? "yes" : "no"} | ${s.production.wallMs === undefined ? "not measured" : `${Math.round(s.production.wallMs / 60000)} min`} | ${t ? `${t.input}/${t.output}/${t.cacheRead}/${t.cacheWrite}` : "not measured"} | ${s.production.costUsd === undefined ? "not measured" : `$${s.production.costUsd.toFixed(2)}`} | ${s.production.humanInterventions} | ${fmt(s.code?.codeLines)} | ${fmt(s.code?.files)} | ${fmt(s.code?.branchDensity)} | ${fmt(s.code?.directServiceCalls)} | ${fmt(s.code?.restatedAccessRules)} | ${s.performance ? `${s.performance.p50Ms} / ${s.performance.p95Ms}` : "–"} | ${violations(s).join(", ") || "none"} |`
        );
      }
    }
    out.push("");
    const contaminated = notes.contamination?.[task];
    if (contaminated?.length) out.push(`Prior art an arm could read (files naming this task's workflow or approval step): ${contaminated.map((f) => `\`${f}\``).join(", ")}.`, "");

    const noted = scores.filter((s) => s.task === task && s.production.notes);
    if (noted.length > 0) out.push("Notes recorded with each run (prior art the arm could read among them):", "", ...noted.map((s) => `- **${s.arm}**: ${s.production.notes}`), "");

    // A loss is a run that passed fewer hidden checks than the best run of *another* arm on the same task (P3-V4).
    const bestOther = (arm: ArmId) => Math.max(-1, ...scores.filter((s) => s.task === task && s.arm !== arm).map((s) => s.passed));
    const losses = scores.filter((s) => s.task === task && s.passed < bestOther(s.arm));
    if (losses.length > 0) {
      out.push("### Losses", "");
      for (const s of losses) {
        out.push(`- **${s.arm}** passed ${s.passed} of ${s.total}${s.diagnostic ? `: ${s.diagnostic}` : ""}.`);
        for (const c of s.checks.filter((c) => !c.ok)) out.push(`  - \`${c.id}\`: ${c.message ?? "failed"}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}
