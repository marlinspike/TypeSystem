import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHost, scaffoldMission, verifyMission, type AcceptanceCheck, type MissionSpec } from "../src/index.js";

/**
 * Independent adversarial review of M4 (ADR-0071): `verify` reporting ok on
 * an application that violates its requirement. Each test fails on 0907181.
 * See docs/reviews/m4-adversarial-review.md.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const MISSION = path.resolve(pkg, "../../examples/missions/component-replacement/mission.json");
const doc = JSON.parse(readFileSync(MISSION, "utf8")) as MissionSpec;
const WORK = path.join(pkg, ".work", "m4-adv-verify");

async function scaffolded(name: string, spec: MissionSpec): Promise<string> {
  const dir = path.join(WORK, name);
  await rm(dir, { recursive: true, force: true });
  const { host } = await loadHost(spec, pkg);
  await scaffoldMission(spec, host, dir);
  return dir;
}

/** The defect the loop test seeds: the approval admits the requester. */
async function seedSelfApproval(dir: string): Promise<void> {
  const file = path.join(dir, "workflow.ts");
  const text = await readFile(file, "utf8");
  const seeded = text.replace('policy: "airforce.maintenance-lead",', 'policy: "airforce.maintenance-lead",\n      allowSelfApproval: true,');
  expect(seeded).not.toBe(text);
  await writeFile(file, seeded);
}

describe("M4 adversarial: verify ok on an application that violates its requirement", () => {
  it("V1: a stale build: with noEmit in the app's tsconfig, the seeded self-approval is not what runs, and verify says ok", async () => {
    const dir = await scaffolded("stale", doc);
    expect((await verifyMission(dir)).ok).toBe(true);
    await seedSelfApproval(dir);
    const tsconfig = JSON.parse(await readFile(path.join(dir, "tsconfig.json"), "utf8")) as { compilerOptions: Record<string, unknown> };
    tsconfig.compilerOptions.noEmit = true;
    await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    const report = await verifyMission(dir);
    // The source in the directory admits the requester; the dist/ that ran is the previous build.
    expect(report.ok).toBe(false);
  }, 180_000);

  it("V2: a typo in an approves check's `step` turns 'lead-cannot-approve-own-request' into a check that passes with the defect seeded", async () => {
    const acceptance = doc.acceptance.map((c) => (c.id === "lead-cannot-approve-own-request" ? { ...c, step: "leadAproval" } : c));
    const dir = await scaffolded("step-typo", { ...doc, acceptance });
    await seedSelfApproval(dir);
    const report = await verifyMission(dir);
    // Today the check passes, observed { admitted: false }: the approval answered 409 (the run waits on "leadApproval", not "leadAproval").
    expect(report.ok).toBe(false);
  }, 180_000);

  it("V3: a workflow check step comparing two fields its initiator may not read passes (undefined equals undefined), so the run goes on", async () => {
    // AF86-0147 is at "FOB ALPHA", AF86-0212 at "Home station": the check must fail the run. A viewer reads neither SECRET location.
    const spec: MissionSpec = {
      ...doc,
      name: "same-location",
      uses: { types: ["airforce.Aircraft"] },
      workflow: {
        name: "airforce.SameLocation",
        version: "1.0.0",
        startPolicy: "airforce.read-aircraft",
        input: ["first", "second"],
        steps: [
          { kind: "read", name: "first", type: "airforce.Aircraft", id: "$input.first" },
          { kind: "read", name: "second", type: "airforce.Aircraft", id: "$input.second" },
          { kind: "check", name: "sameLocation", equal: ["$first.deploymentLocation", "$second.deploymentLocation"], message: "the aircraft are not at the same location" }
        ]
      },
      views: [],
      acceptance: [
        { id: "maintainer-different-locations-fail", kind: "starts", as: "maintainer", workflow: "airforce.SameLocation", input: { first: "AF86-0147", second: "AF86-0212" }, status: "failed" },
        { id: "viewer-different-locations-fail", kind: "starts", as: "viewer", workflow: "airforce.SameLocation", input: { first: "AF86-0147", second: "AF86-0212" }, status: "failed" }
      ]
    };
    const report = await verifyMission(await scaffolded("withheld-check", spec));
    expect(report.checks.map((c) => [c.id, c.ok])).toEqual([
      ["maintainer-different-locations-fail", true],
      ["viewer-different-locations-fail", true]
    ]);
  }, 180_000);

  it("V4: checks share one server's state, so a check's verdict depends on where it sits in the list", async () => {
    // "No work order exists until a lead approves one": true of the application, but verify runs it after an approves check opened one.
    const noWorkOrder: AcceptanceCheck = { id: "no-work-order-without-approval", kind: "query", as: "viewer", query: { type: "airforce.WorkOrder" }, atMost: 0 };
    const dir = await scaffolded("order", { ...doc, uses: { ...doc.uses, types: [...doc.uses.types, "airforce.WorkOrder"] }, acceptance: [...doc.acceptance, noWorkOrder] });
    const report = await verifyMission(dir);
    expect(report.checks.find((c) => c.id === noWorkOrder.id)).toMatchObject({ ok: true });
  }, 180_000);
});
