import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeModel, requireRole } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { dependents, nodeId, semanticGraph } from "@typesys/devkit";
import { appUses } from "../src/uses.js";
import { appCommand } from "../src/cli.js";
import { squadronDir } from "./apps.js";
import { squadronApp } from "./fixtures.js";

async function graphOf(app = squadronApp()) {
  const tb = await buildAirforceTestbed({ runtimeOptions: { inspection: { policy: "typesys.inspect" } } });
  (tb.policyEngine as unknown as { registerRule(n: string, r: unknown): void }).registerRule("typesys.inspect", requireRole("lead"));
  return semanticGraph(await tb.runtime.inspectModel(demoIdentities.lead), appUses(app, await describeModel(tb.registry)));
}

const APP = "app:squadron-maintenance";
const FLOW = "workflow:airforce.GroundAircraft";

describe("application uses (ADR-0090)", () => {
  it("states what each data, page, check and flow step uses, down to the members a component shows", async () => {
    const [app, flow] = appUses(squadronApp(), await describeModel((await buildAirforceTestbed()).registry));
    expect(app!.kind).toBe("app");
    const part = (n: string) => app!.parts.find((p) => p.name === n)!;
    expect(part("data.attention").uses).toEqual(
      expect.arrayContaining([
        { kind: "member", type: "airforce.Aircraft", member: "readinessStatus", how: "select" },
        { kind: "member", type: "airforce.Aircraft", member: "needsAttention", how: "filter" }
      ])
    );
    expect(part("page.Board").uses).toEqual(expect.arrayContaining([{ kind: "member", type: "airforce.Aircraft", member: "deploymentLocation", how: "field" }, { kind: "consumer", consumer: "workflow", name: "airforce.GroundAircraft", how: "run" }]));
    expect(part("check.viewer-lacks-status").uses).toContainEqual({ kind: "member", type: "airforce.Aircraft", member: "maintenanceStatus", how: "withheld" });
    expect(flow).toMatchObject({ kind: "workflow", name: "airforce.GroundAircraft", within: "squadron-maintenance" });
    // With the model, a relationship read resolves to its target Type.
    expect(flow!.parts.find((p) => p.name === "history")!.uses).toContainEqual({ kind: "type", type: "airforce.MaintenanceEvent", whole: true, how: "related" });
  });

  it("lets a change to one member be traced to the application's pages, checks and flow steps it reaches", async () => {
    const g = await graphOf();
    const reach = dependents(g, nodeId.member("airforce.Aircraft", "maintenanceStatus"));
    const ids = reach.reached.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        nodeId.part(APP, "data.attention"),
        nodeId.part(APP, "page.Board"),
        nodeId.part(APP, "check.viewer-lacks-status"),
        nodeId.part(APP, "check.board-shows-attention"),
        nodeId.part(FLOW, "aircraft")
      ])
    );
    expect(reach.consumers).toEqual([APP, FLOW]);
    // The flow sits in the application, so it is reached as part of it.
    expect(g.nodes.find((n) => n.id === FLOW)?.parent).toBe(APP);
  });

  it("names a removed member the application still uses as unresolved", async () => {
    const app = squadronApp();
    (app.data!.attention as unknown as { query: { select: string[] } }).query.select.push("fuelState");
    const g = await graphOf(app);
    expect(g.nodes.find((n) => n.id === nodeId.member("airforce.Aircraft", "fuelState"))?.unresolved).toBe(true);
    expect(dependents(g, nodeId.member("airforce.Aircraft", "fuelState")).reached.map((r) => r.id)).toContain(nodeId.part(APP, "data.attention"));
  });
});

describe("typesys app inspect, why and graph", () => {
  const run = async (argv: string[]) => {
    let printed = "";
    const code = await appCommand([...argv, "--json"], (s) => (printed = s));
    return { code, out: JSON.parse(printed) as Record<string, unknown> };
  };
  const workbench = () => {
    const app = squadronApp();
    return squadronDir("workbench-cli", { ...app, host: { ...app.host, build: "buildAirforceWorkbench" } });
  };

  it("inspects for the lead and refuses the viewer", async () => {
    const dir = await workbench();
    const lead = await run(["inspect", dir, "--as", "lead", "--type", "airforce.Aircraft"]);
    expect(lead.code).toBe(0);
    expect((lead.out.types as { name: string }[]).map((t) => t.name)).toEqual(["airforce.Aircraft"]);
    const viewer = await run(["inspect", dir, "--as", "viewer"]);
    expect(viewer.code).toBe(1);
  });

  it("explains why the viewer is shown a partial Aircraft, to the lead", async () => {
    const dir = await workbench();
    const r = await run(["why", dir, "--as", "lead", "--for", "viewer", "--read", "airforce.Aircraft/AF86-0147"]);
    expect(r.out).toMatchObject({ ok: true, outcome: "partial", disclosure: "inspector" });
    expect((await run(["why", dir, "--as", "lead"])).out.error).toMatch(/needs one of/);
  });

  it("answers what a change to a value reaches in this application", async () => {
    const dir = await workbench();
    const r = await run(["graph", dir, "--as", "lead", "--view", "dependents", "--node", "member:airforce.Aircraft.maintenanceStatus"]);
    expect(r.out.consumers).toEqual([APP, FLOW]);
    expect((await run(["graph", dir, "--as", "viewer"])).out.structure).toBe("description");
  });
  it("records a baseline, then names what a proposed release exposes, to whom, and the application's checks it reaches (ADR-0093)", async () => {
    const dir = await workbench();
    const baseline = path.join(dir, "..", "workbench-cli.baseline.json");
    const recorded = await run(["impact", dir, "--as", "lead", "--record", baseline]);
    expect(recorded.out).toMatchObject({ ok: true, inspected: true });
    expect((await run(["impact", dir, "--as", "lead", "--against", baseline])).out).toMatchObject({ ok: true, verdict: "compatible", items: [] });
    const app = squadronApp();
    const proposed = await squadronDir("workbench-cli-proposal", { ...app, host: { ...app.host, build: "buildAirforceProposal" } });
    const r = await run(["impact", proposed, "--as", "lead", "--against", baseline]);
    expect(r.code).toBe(1);
    const exposures = r.out.exposures as { subject: string; as: string; reaches: { consumers: string[] } }[];
    expect(exposures.map((e) => [e.subject, e.as])).toContainEqual(["airforce.Aircraft.readinessStatus", "viewer"]);
    expect(exposures[0]!.reaches.consumers).toContain(APP);
    // Only the application's acceptance checks: a flow's own check step runs inside the flow.
    expect((r.out.checks as string[]).length).toBeGreaterThan(0);
    for (const c of r.out.checks as string[]) expect(c.startsWith(`part:${APP}/check.`)).toBe(true);
    expect((await run(["impact", dir, "--as", "lead"])).out.error).toMatch(/--record or --against/);
  });

  it("probes the links that cross systems, and counts dangling ones only for an inspector explaining a caller (ADR-0094)", async () => {
    const dir = await workbench();
    const r = await run(["links", dir, "--as", "lead", "--for", "viewer", "--cross-source"]);
    expect(r.code).toBe(0);
    const maintenance = (r.out.relationships as { relationship: string; crossSource?: { through: string }; dangling?: number }[]).find((x) => x.relationship === "maintenance")!;
    expect(maintenance.crossSource?.through).toBe("mock-remis-rest");
    expect(maintenance.dangling).toBe(0);
    const own = await run(["links", dir, "--as", "viewer"]);
    expect((own.out.relationships as { dangling?: number }[]).every((x) => x.dangling === undefined)).toBe(true);
  });

  it("gives a context that lists the application's own parts and checks with each Type, and its guards to the lead only (ADR-0092)", async () => {
    const dir = await workbench();
    const lead = (await run(["context", dir, "--as", "lead"])).out as unknown as { governance: string; checks: { consumer: string }[]; types: { name: string; usedBy: { consumer: string }[] }[]; text: string };
    expect(lead.governance).toBe("shown");
    expect(lead.checks.length).toBeGreaterThan(0);
    expect(lead.types.find((t) => t.name === "airforce.Aircraft")!.usedBy.map((u) => u.consumer)).toContain(`app ${APP.replace(/^app:/, "")}`);
    expect(lead.text).toContain("CHECKS a change must keep passing");
    const viewer = (await run(["context", dir, "--as", "viewer"])).out as unknown as { governance: string; text: string };
    expect(viewer.governance).toBe("withheld");
    expect(viewer.text).not.toContain("airforce.maintainer-only");
  });
});
