import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadHost, planMission, scaffoldMission, verifyMission, type MissionSpec } from "@typesys/engineer";
import type { SortieHost } from "../src/index.js";

/**
 * The sortie-readiness mission (ADR-0072) through the engineering loop
 * (ADR-0071): an application over three independently written services,
 * planned against the governed model, scaffolded, built, and verified with
 * each check run as its caller against a freshly started copy, which
 * starts its own three services.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const MISSION = path.resolve(pkg, "../../examples/missions/sortie-readiness/mission.json");
const WORK = path.join(pkg, ".work");
const doc = JSON.parse(readFileSync(MISSION, "utf8")) as MissionSpec;

const hosts: SortieHost[] = [];
afterAll(async () => {
  for (const h of hosts) await h.services?.stop();
});

async function scaffolded(name: string): Promise<string> {
  const dir = path.join(WORK, name);
  await rm(dir, { recursive: true, force: true });
  const loaded = await loadHost(doc, pkg);
  hosts.push(loaded.host);
  await scaffoldMission(doc, loaded.host, dir);
  return dir;
}

describe("the sortie-readiness mission", () => {
  it("plans against the model over three services with no error, and finds the cross-service relationships", async () => {
    const { host, resolve, workflows } = await loadHost(doc, pkg);
    hosts.push(host);
    const plan = await planMission(doc, host, resolve, workflows);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.provided.types.map((t) => t.name)).toEqual(["ops.Aircraft", "ops.CrewMember", "ops.Requisition"]);
    expect(plan.provided.relationships.map((r) => `${r.from}.${r.name} → ${r.target}`).sort()).toEqual(["ops.Aircraft.crew → ops.CrewMember", "ops.Aircraft.requisitions → ops.Requisition"]);
  });

  it("verifies: every check passes as its caller, through the application's API", { timeout: 300_000 }, async () => {
    const report = await verifyMission(await scaffolded("verified"));
    expect(report.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks).toHaveLength(doc.acceptance.length);
    expect(report.ok).toBe(true);
  });

  it("a sign-off opened to maintainers in the application fails exactly the check that excludes them", { timeout: 300_000 }, async () => {
    const dir = await scaffolded("seeded");
    const file = path.join(dir, "workflow.ts");
    const text = await readFile(file, "utf8");
    const seeded = text.replace('policy: "ops.sortie-signoff"', 'policy: "ops.crew"');
    expect(seeded).not.toBe(text);
    await writeFile(file, seeded);
    const report = await verifyMission(dir);
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["maintainer-cannot-sign-off"]);
  });
});
