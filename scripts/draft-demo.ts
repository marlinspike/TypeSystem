/**
 * From a requirement in words to a verified application (ADR-0077):
 *
 *   npm run build && npm run draft:demo
 *
 * Replays the drafting of examples/missions/fleet-readiness-board: a
 * coding agent, acting as the development model, answered the brief from
 * the model context compiled for its author; TypeSystem planned the
 * answer; verify found one check that assumed data the fleet does not
 * have, and that went back to the agent, which answered again. The
 * replayed spec is then scaffolded and verified here, from scratch.
 */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { recordedModel, type LlmRecording } from "@typesys/llm";
import { draftMission, loadHost, scaffoldMission, verifyMission, type MissionBrief } from "@typesys/engineer";

const DIR = path.resolve(import.meta.dirname, "../examples/missions/fleet-readiness-board");
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as T;
const brief = read<MissionBrief>("brief.json");
const { recordings } = read<{ recordings: LlmRecording[] }>("mission.draft.json");

console.log(`Requirement: ${brief.requirement}\n`);
const loaded = await loadHost(brief, path.resolve(import.meta.dirname, "../packages/engineer"));
const draft = await draftMission(brief, loaded, recordedModel(recordings, brief.agentAudience), { feedback: [readFileSync(path.join(DIR, "feedback-1.txt"), "utf8")] });
console.log(`Context for the model: ${draft.context.tokens} tokens, ${draft.context.types.length} Types, ${draft.context.actions.length} Actions, read as ${draft.context.as} for ${draft.context.audience}`);
for (const [i, r] of draft.rounds.entries()) {
  console.log(`Round ${i + 1}${r.feedback ? " (after verify's feedback)" : ""}: ${r.call.inputTokens} in / ${r.call.outputTokens} out tokens (estimated); ${r.diagnostics.length ? r.diagnostics.map((d) => `${d.severity} ${d.code}`).join(", ") : "no diagnostics"}`);
}
if (!draft.ok || !draft.spec) throw new Error("The draft has errors");
console.log(`\nDrafted ${draft.spec.name}: ${draft.spec.views?.length ?? 0} views, ${draft.spec.acceptance.length} acceptance checks`);

// Inside the workspace, where the application resolves its host module as it would in a project.
const dir = path.resolve(import.meta.dirname, "../packages/engineer/.work/draft-demo");
await rm(dir, { recursive: true, force: true });
const files = await scaffoldMission(draft.spec, loaded.host, dir);
console.log(`Scaffolded ${files.length} files into ${dir}`);
const report = await verifyMission(dir);
for (const c of report.checks) console.log(`  ${c.ok ? "pass" : "FAIL"}  ${c.id}`);
for (const d of report.diagnostics) console.log(`  ${d.severity} ${d.code}: ${d.message}`);
console.log(report.ok ? "\nVerified: every acceptance check passed through the application's own API." : "\nNOT verified");
process.exitCode = report.ok ? 0 : 1;
