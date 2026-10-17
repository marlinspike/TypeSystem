import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MissionSpec } from "@typesys/engineer";
import { appCommand, findChromium, missionToApp, verifyApp, type AppSpec, type ScreenCheck } from "../src/index.js";
import { WORK } from "./apps.js";

/**
 * A mission becomes an application (ADR-0086): exact where a check can
 * tell, with every change it makes said at its place in the mission.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SORTIE = path.resolve(here, "../../../examples/missions/sortie-readiness/mission.json");
const sortie = async () => JSON.parse(await readFile(SORTIE, "utf8")) as MissionSpec;
const run = async (argv: string[]) => {
  let printed = "";
  const code = await appCommand([...argv, "--json"], (s) => (printed = s));
  return { code, out: JSON.parse(printed) as Record<string, unknown> };
};

describe("missionToApp", () => {
  it("keeps the host, the callers, every check and every step name, and says what it changed", async () => {
    const mission = await sortie();
    const { spec, diagnostics } = missionToApp(mission);
    expect(spec!.host).toEqual(mission.host);
    expect(spec!.callers).toEqual(mission.callers);
    expect(spec!.acceptance).toEqual(mission.acceptance);
    const flow = spec!.flows!.confirmSortie!;
    expect(flow.steps.map((s) => s.name)).toEqual(mission.workflow!.steps.map((s) => s.name));
    expect(flow.input.tailNumber).toEqual({ schema: { type: "string", minLength: 1 }, objectOf: "ops.Aircraft" });
    expect(flow.steps[2]).toEqual({ kind: "check", name: "pilotAssigned", assert: { eq: ["$pilot.assignedTail", "$aircraft.tailNumber"] }, message: "the pilot is not assigned to this aircraft" });
    expect(flow.steps[3]).toMatchObject({ kind: "approval", present: ["aircraft", "pilot"], deadlineMs: 86400000 });
    expect(diagnostics.every((d) => d.code === "mission-translation" && d.severity === "info")).toBe(true);
    expect(diagnostics.map((d) => d.at)).toEqual(expect.arrayContaining(["/workflow/steps/2", "/views", "/uses/types/2"]));
  });

  it("translates an Action and its compensation unchanged", () => {
    const { spec } = missionToApp({
      format: "typesys.mission/1",
      name: "replace",
      requirement: "Replace a part.",
      host: { module: "./host.js", build: "build", identities: "who" },
      callers: { a: { token: "t" } },
      uses: { types: [], actions: ["Install", "Remove"] },
      workflow: {
        name: "x.Replace",
        version: "1.0.0",
        startPolicy: "x.p",
        input: ["partId"],
        steps: [{ kind: "action", name: "install", action: "Install", input: { partId: "$input.partId", count: 1 }, compensate: { action: "Remove", input: { id: "$output.id" } } }]
      },
      acceptance: [{ id: "starts", kind: "starts", as: "a", workflow: "x.Replace", input: { partId: "P-1" }, status: "completed" }]
    });
    expect(spec!.flows!.replace!.steps[0]).toEqual({ kind: "action", name: "install", action: "Install", input: { partId: "$input.partId", count: 1 }, compensate: { action: "Remove", input: { id: "$output.id" } } });
  });

  it("refuses an invalid mission with its own diagnostics, as JSON Pointers", () => {
    const r = missionToApp({ format: "typesys.mission/1", name: "Bad Name" });
    expect(r.spec).toBeUndefined();
    expect(r.diagnostics.find((d) => d.code === "invalid-mission")).toMatchObject({ at: "/name" });
  });
});

describe("typesys app migrate", () => {
  it("writes app.json, keeps a host path pointing at the same file, and never replaces an app.json unasked", async () => {
    const src = path.join(WORK, "migrate-src");
    const out = path.join(WORK, "migrate-out", "app");
    await rm(path.join(WORK, "migrate-out"), { recursive: true, force: true });
    await mkdir(src, { recursive: true });
    const mission = { ...(await sortie()), host: { module: "./host.js", build: "b", identities: "i" } };
    await writeFile(path.join(src, "mission.json"), JSON.stringify(mission));
    const r = await run(["migrate", path.join(src, "mission.json"), "--out", out]);
    expect(r.code).toBe(0);
    const written = JSON.parse(await readFile(path.join(out, "app.json"), "utf8")) as AppSpec;
    expect(written.host.module).toBe("../../migrate-src/host.js");
    expect((await run(["migrate", path.join(src, "mission.json"), "--out", out])).code).toBe(1);
    expect((await run(["migrate", path.join(src, "mission.json"), "--out", out, "--force"])).code).toBe(0);
  });

  it("produces an application that passes the mission's own checks, and shows each caller what the runtime releases", async () => {
    const dir = path.join(WORK, "sortie-migrated-test");
    await rm(dir, { recursive: true, force: true });
    expect((await run(["migrate", SORTIE, "--out", dir])).code).toBe(0);
    const spec = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8")) as AppSpec;
    const screens: ScreenCheck[] = findChromium()
      ? [
          { id: "planner-sees-fleet", kind: "screen", as: "planner", page: "FleetBoard", visible: ["fleet-board-table", "crew-list-table", "confirm-sortie-form"], rows: { "fleet-board-table": { atLeast: 4 } }, text: ["Capt Dana Reyes"] },
          { id: "viewer-refused-crew-on-screen", kind: "screen", as: "viewer", page: "FleetBoard", rows: { "crew-list-table": { atMost: 0 } }, text: ["not permitted"], absentText: ["Capt Dana Reyes"] }
        ]
      : [];
    await writeFile(path.join(dir, "app.json"), JSON.stringify({ ...spec, acceptance: [...spec.acceptance, ...screens] }));
    const r = await verifyApp(dir);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks).toHaveLength(15 + screens.length);
  }, 180_000);
});
