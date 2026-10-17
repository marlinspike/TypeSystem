import { describe, expect, it } from "vitest";
import { describeModel, requireRole } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { dependents, nodeId, semanticGraph } from "@typesys/devkit";
import { appUses } from "../src/uses.js";
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
