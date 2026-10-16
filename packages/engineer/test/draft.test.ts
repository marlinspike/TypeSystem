import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { answeringModel, LlmError, recordedModel, type LlmRecording } from "@typesys/llm";
import { draftMission, engineerCommand, loadHost, scaffoldMission, verifyMission, type MissionBrief, type MissionDraft, type MissionSpec } from "../src/index.js";

/**
 * Drafting a mission from words (ADR-0077): the model proposes, and
 * TypeSystem decides. The example's answers were written by a coding agent
 * in agent mode; the repair tests use scripted answers seeded with the
 * mistakes a model makes.
 */
const DIR = path.resolve(import.meta.dirname, "../../../examples/missions/fleet-readiness-board");
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as T;
const brief = read<MissionBrief>("brief.json");
const answer1 = read<MissionDraft>("answers/1.json");
const pkg = path.resolve(import.meta.dirname, "..");

describe("draftMission", () => {
  it("replays the agent's recorded drafting, with verify's feedback, to the committed mission", async () => {
    const loaded = await loadHost(brief, pkg);
    const { recordings } = read<{ recordings: LlmRecording[] }>("mission.draft.json");
    const r = await draftMission(brief, loaded, recordedModel(recordings, brief.agentAudience), { feedback: [readFileSync(path.join(DIR, "feedback-1.txt"), "utf8")] });
    expect(r.ok).toBe(true);
    expect(r.spec).toEqual(read<MissionSpec>("mission.json"));
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds[1]!.diagnostics).toContainEqual(expect.objectContaining({ code: "check-dropped", severity: "warning" }));
  });

  it("the drafted mission scaffolds into an application that passes every check through its own API", { timeout: 180_000 }, async () => {
    const spec = read<MissionSpec>("mission.json");
    const loaded = await loadHost(spec, pkg);
    const dir = path.join(pkg, ".work", "draft-fleet-readiness");
    await rm(dir, { recursive: true, force: true });
    await scaffoldMission(spec, loaded.host, dir);
    const report = await verifyMission(dir);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(spec.acceptance.length);
  });

  it("sends the planner's errors back until none is left, and never lets the model choose the host, the callers or a policy", async () => {
    const loaded = await loadHost(brief, pkg);
    const broken = {
      ...answer1,
      uses: { types: ["airforce.Aircraft", "airforce.Componnet"], actions: ["CreateMaintenanceWorkOrder"] },
      acceptance: answer1.acceptance.filter((c) => c.as !== "lead"),
      workflow: { name: "airforce.Board", version: "1.0.0", startPolicy: "airforce.anyone", input: ["id"], steps: [{ kind: "read", name: "aircraft", type: "airforce.Aircraft", id: "$input.id" }] }
    };
    const agent = answeringModel([broken, answer1], "test");
    const r = await draftMission(brief, loaded, agent.model);
    expect(r.ok).toBe(true);
    expect(r.rounds[0]!.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).sort()).toEqual(["caller-unchecked", "unknown-policy", "unknown-type"]);
    expect(r.spec!.host).toEqual(brief.host);
    expect(r.spec!.callers).toEqual(brief.callers);
    expect(r.spec!.requirement).toBe(brief.requirement);
    // The second request carried the errors, with their fixes: a third answer is asked for only after them.
    const asked = answeringModel([broken], "test");
    await draftMission(brief, loaded, asked.model).catch(() => undefined);
    const repair = JSON.stringify(asked.needed()!.messages.at(-1));
    expect(repair).toContain("unknown-type at uses/types/1");
    expect(repair).toContain('did you mean \\"airforce.Component\\"?');
    expect(repair).toContain("unknown-policy at workflow/startPolicy");
    const hostile = answeringModel([{ ...answer1, host: { module: "./evil.js", build: "x", identities: "y" } }, { ...answer1, host: { module: "./evil.js", build: "x", identities: "y" } }], "test");
    const err = await draftMission(brief, loaded, hostile.model).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe("invalid-output");
  });

  it("stops after its rounds with the errors left, for a person", async () => {
    const loaded = await loadHost(brief, pkg);
    const bad = { ...answer1, uses: { types: ["airforce.Nothing"] } };
    const r = await draftMission(brief, loaded, answeringModel([bad, bad], "test").model, { maxRounds: 2 });
    expect(r.ok).toBe(false);
    expect(r.rounds).toHaveLength(2);
  });

  it("gives the model only what its author may share with it: nothing a model granted nothing may receive", async () => {
    const loaded = await loadHost(brief, pkg);
    const granted = answeringModel([], "test", { audience: brief.agentAudience! });
    await draftMission(brief, loaded, granted.model).catch(() => undefined);
    const prompt = JSON.stringify(granted.needed());
    expect(prompt).toContain("reading for model:agent");
    expect(prompt).toContain("AF86-0147");
    expect(prompt).not.toContain("FOB");
    expect(prompt).not.toMatch(/"maintenanceStatus":"(operational|degraded|down)"/);
    const nothing = answeringModel([], "test");
    await draftMission(brief, loaded, nothing.model).catch(() => undefined);
    expect(JSON.stringify(nothing.needed())).toContain("(none readable)");
  });
});

describe("typesys engineer draft", () => {
  it("asks for the agent's answer, then drafts with it", async () => {
    // Inside the package, so the brief's host module resolves as it would beside an application.
    mkdirSync(path.join(pkg, ".work"), { recursive: true });
    const dir = mkdtempSync(path.join(pkg, ".work", "draft-cli-"));
    writeFileSync(path.join(dir, "brief.json"), JSON.stringify(brief));
    writeFileSync(path.join(dir, "1.json"), JSON.stringify(answer1));
    const lines: string[] = [];
    const out = path.join(dir, "mission.json");
    expect(await engineerCommand(["draft", path.join(dir, "brief.json"), "--out", out], (s) => lines.push(s))).toBe(2);
    expect(readFileSync(path.join(dir, "mission.request.txt"), "utf8")).toContain("REQUIREMENT:");
    expect(await engineerCommand(["draft", path.join(dir, "brief.json"), "--out", out, "--answer", path.join(dir, "1.json"), "--json"], (s) => lines.push(s))).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, rounds: 1 });
    expect((JSON.parse(readFileSync(out, "utf8")) as MissionSpec).name).toBe("fleet-readiness-board");
  });
});
