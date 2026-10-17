import { beforeAll, describe, expect, it } from "vitest";
import { describeModel, requireRole, type ModelInspection } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { workflowUses } from "../../workflow/src/uses.js";
import { dependencies, dependents, neighborhood, nodeId, overview, semanticGraph, type GraphConsumer } from "../src/index.js";

let inspection: ModelInspection;

beforeAll(async () => {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { inspection: { policy: "typesys.inspect" } } });
  (tb.policyEngine as unknown as { registerRule(n: string, r: unknown): void }).registerRule("typesys.inspect", requireRole("lead"));
  inspection = await tb.runtime.inspectModel(demoIdentities.lead);
});

const AIRCRAFT = nodeId.type("airforce.Aircraft");
const MAINTENANCE_STATUS = nodeId.member("airforce.Aircraft", "maintenanceStatus");

/** A small consumer of the kind `appUses` produces: a page that reads the readiness board, and a check of it. */
const board: GraphConsumer = {
  kind: "app",
  name: "readiness-board",
  uses: [],
  parts: [
    { name: "data.fleet", kind: "data", uses: [{ kind: "type", type: "airforce.Aircraft", how: "query" }, { kind: "member", type: "airforce.Aircraft", member: "readinessStatus", how: "select" }] },
    { name: "page.Board", kind: "page", uses: [{ kind: "part", part: "data.fleet", how: "shows" }] },
    { name: "check.viewer-sees-board", kind: "check", uses: [{ kind: "part", part: "page.Board", how: "screen" }] }
  ]
};

describe("semantic graph (ADR-0090)", () => {
  it("connects the model's members, sources, policies and markings from an inspection", () => {
    const g = semanticGraph(inspection);
    expect(g.structure).toBe("inspection");
    expect(g.modelDigest).toBe(inspection.modelDigest);
    const edge = (from: string, kind: string, to: string) => g.edges.some((e) => e.from === from && e.kind === kind && e.to === to);
    expect(edge(MAINTENANCE_STATUS, "guarded-by", nodeId.policy("airforce.maintainer-only"))).toBe(true);
    expect(edge(MAINTENANCE_STATUS, "reads-from", nodeId.source("in-memory-airforce-repo"))).toBe(true);
    expect(edge(nodeId.member("airforce.Aircraft", "readinessStatus"), "derives-from", MAINTENANCE_STATUS)).toBe(true);
    expect(edge(nodeId.member("airforce.Aircraft", "needsAttention"), "released-from", MAINTENANCE_STATUS)).toBe(true);
    expect(edge(nodeId.member("airforce.Aircraft", "needsAttention"), "reads-from", nodeId.source("mock-remis-rest"))).toBe(true);
    expect(edge(nodeId.member("airforce.Aircraft", "deploymentLocation"), "marked", nodeId.marking("SECRET"))).toBe(true);
    expect(edge(nodeId.relationship("airforce.Aircraft", "maintenance"), "targets", nodeId.type("airforce.MaintenanceEvent"))).toBe(true);
    expect(edge(nodeId.action("CreateMaintenanceWorkOrder"), "writes-to", nodeId.source("mock-remis-rest"))).toBe(true);
    expect(g.nodes.find((n) => n.id === nodeId.policy("airforce.maintainer-only"))?.detail?.rule).toBe("role in [maintainer, ai-enclave]");
  });

  it("is the same graph, by digest, however often it is built", () => {
    const a = semanticGraph(inspection, [workflowUses(groundForRepair)]);
    const b = semanticGraph(structuredClone(inspection), [workflowUses(groundForRepair)]);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(semanticGraph(inspection).digest);
  });

  it("finds what a change to a stored value reaches: the values derived from it, the workflow steps and the application's page and check", () => {
    const g = semanticGraph(inspection, [workflowUses(groundForRepair), board]);
    const reach = dependents(g, MAINTENANCE_STATUS);
    const ids = reach.reached.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([nodeId.member("airforce.Aircraft", "readinessStatus"), nodeId.member("airforce.Aircraft", "needsAttention")]));
    // The workflow's read step reads the whole Aircraft; the board selects readinessStatus, which derives from it.
    expect(ids).toContain(nodeId.part("workflow:airforce.GroundForRepair", "aircraft"));
    expect(ids).toEqual(expect.arrayContaining([nodeId.part("app:readiness-board", "data.fleet"), nodeId.part("app:readiness-board", "page.Board"), nodeId.part("app:readiness-board", "check.viewer-sees-board")]));
    expect(reach.consumers).toEqual(["app:readiness-board", "workflow:airforce.GroundForRepair"]);
    const check = reach.reached.find((r) => r.id === nodeId.part("app:readiness-board", "check.viewer-sees-board"))!;
    expect(check.path).toEqual([MAINTENANCE_STATUS, nodeId.member("airforce.Aircraft", "readinessStatus"), nodeId.part("app:readiness-board", "data.fleet"), nodeId.part("app:readiness-board", "page.Board"), check.id]);
  });

  it("does not reach a consumer that selects only values unrelated to the change", () => {
    const tailOnly: GraphConsumer = { kind: "app", name: "tails", uses: [], parts: [{ name: "data.t", kind: "data", uses: [{ kind: "type", type: "airforce.Aircraft", how: "query" }, { kind: "member", type: "airforce.Aircraft", member: "tailNumber", how: "select" }] }] };
    const reach = dependents(semanticGraph(inspection, [tailOnly]), MAINTENANCE_STATUS);
    expect(reach.consumers).toEqual([]);
  });

  it("finds what a policy guards, so a policy change names every Type, value, Action and workflow it decides", () => {
    const g = semanticGraph(inspection, [workflowUses(groundForRepair)]);
    const reach = dependents(g, nodeId.policy("airforce.maintainer-only"), { depth: 1 });
    expect(reach.reached.map((r) => r.id)).toEqual(expect.arrayContaining([MAINTENANCE_STATUS, "workflow:airforce.GroundForRepair"]));
    expect(reach.reached.every((r) => r.via === "guarded-by")).toBe(true);
  });

  it("finds what a workflow rests on, through its declared reads and Actions to sources and policies", () => {
    const g = semanticGraph(inspection, [workflowUses(groundForRepair)]);
    const ids = dependencies(g, "workflow:airforce.GroundForRepair").reached.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([AIRCRAFT, MAINTENANCE_STATUS, nodeId.source("mock-remis-rest"), nodeId.policy("airforce.maintenance-lead"), nodeId.action("CreateMaintenanceWorkOrder")]));
  });

  it("marks a read step that declares nothing as opaque instead of guessing what it reads", () => {
    const undeclared = { ...groundForRepair, steps: groundForRepair.steps.map((s) => (s.kind === "read" ? { ...s, reads: undefined } : s)) };
    const g = semanticGraph(inspection, [workflowUses(undeclared as typeof groundForRepair)]);
    const part = g.nodes.find((n) => n.id === nodeId.part("workflow:airforce.GroundForRepair", "aircraft"))!;
    expect(part.detail?.opaque).toMatch(/may read any Type/);
    expect(dependents(g, MAINTENANCE_STATUS).reached.map((r) => r.id)).not.toContain(part.id);
  });

  it("keeps a use of something the model does not describe as an unresolved node, without saying whether it exists", () => {
    const stale: GraphConsumer = { kind: "app", name: "stale", uses: [], parts: [{ name: "data.x", kind: "data", uses: [{ kind: "member", type: "airforce.Aircraft", member: "fuelState", how: "select" }] }] };
    const g = semanticGraph(inspection, [stale]);
    expect(g.nodes.find((n) => n.id === nodeId.member("airforce.Aircraft", "fuelState"))).toMatchObject({ unresolved: true, parent: AIRCRAFT });
    expect(g.nodes.find((n) => n.id === AIRCRAFT)?.unresolved).toBeUndefined();
    const dropped = semanticGraph(inspection, [stale], { unresolved: "drop" });
    expect(JSON.stringify(dropped)).not.toContain("fuelState");
    expect(dropped.nodes.some((n) => n.id === nodeId.part("app:stale", "data.x"))).toBe(true);
  });

  it("builds from a description when the caller may not inspect, with the enforcement structure absent", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const g = semanticGraph(await describeModel(tb.registry, { prefixes: ["airforce."] }), [workflowUses(groundForRepair)]);
    expect(g.structure).toBe("description");
    expect(g.nodes.some((n) => n.kind === "policy" || n.kind === "source" || n.kind === "marking")).toBe(false);
    expect(g.edges.some((e) => e.kind === "derives-from" && e.to === MAINTENANCE_STATUS)).toBe(true);
  });

  it("opens a large model progressively: an overview of Types and consumers, then one node's neighborhood within a limit", () => {
    const g = semanticGraph(inspection, [workflowUses(groundForRepair), board]);
    const o = overview(g);
    expect(o.nodes.some((n) => n.kind === "member" || n.kind === "part")).toBe(false);
    expect(o.edges.some((e) => e.from === "workflow:airforce.GroundForRepair" && e.to === AIRCRAFT)).toBe(true);
    expect(o.more).toContain(AIRCRAFT);
    const n = neighborhood(g, MAINTENANCE_STATUS, { depth: 1 });
    expect(n.nodes.map((x) => x.id)).toEqual(expect.arrayContaining([MAINTENANCE_STATUS, AIRCRAFT, nodeId.policy("airforce.maintainer-only")]));
    expect(n.more.length).toBeGreaterThan(0);
    const capped = neighborhood(g, AIRCRAFT, { depth: 3, limit: 10 });
    expect(capped.nodes.length).toBeLessThanOrEqual(10);
  });

  it("refuses a node it does not have", () => {
    expect(() => dependents(semanticGraph(inspection), "type:nope.Nothing")).toThrow(/no node/);
  });
});
