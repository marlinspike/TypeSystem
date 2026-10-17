import { beforeAll, describe, expect, it } from "vitest";
import type { ModelInspection } from "@typesys/core";
import { airforceManifest, buildAirforceProposal, buildAirforceWorkbench, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { workflowUses } from "../../workflow/src/uses.js";
import { analyzeChange, diffGovernance, governedBaseline, isBaseline, recordBaseline, renderImpact, subjectNode, type Baseline, type GraphConsumer } from "../src/index.js";

/**
 * Change impact (ADR-0093): a baseline of the model and of each caller's
 * decided reads, compared with the model as it is after a change. The
 * demonstration change releases readinessStatus to viewers, which maps
 * the maintainer-only maintenanceStatus one to one.
 */
const callers = { maintainer: demoIdentities.maintainer, viewer: demoIdentities.viewer, anonymous: demoIdentities.anonymous };
const board: GraphConsumer = {
  kind: "app",
  name: "readiness-board",
  uses: [],
  parts: [
    { name: "data.fleet", kind: "data", uses: [{ kind: "type", type: "airforce.Aircraft", how: "query" }] },
    { name: "page.Board", kind: "page", uses: [{ kind: "part", part: "data.fleet", how: "shows" }] },
    { name: "check.viewer-withheld-readiness", kind: "check", uses: [{ kind: "member", type: "airforce.Aircraft", member: "readinessStatus", how: "withheld" }] }
  ]
};
const consumers = [board, workflowUses(groundForRepair as never)];

let before: Baseline;
let after: Baseline;

beforeAll(async () => {
  before = await recordBaseline((await buildAirforceWorkbench({ mockRestLatencyMs: 0 })).runtime, demoIdentities.lead, { callers });
  after = await recordBaseline((await buildAirforceProposal({ mockRestLatencyMs: 0 })).runtime, demoIdentities.lead, { callers });
});

describe("a baseline", () => {
  it("holds the model, the inspection and each caller's decided reads, never a value", () => {
    expect(isBaseline(before)).toBe(true);
    expect(before.inspection).toBeDefined();
    const viewerRead = before.probes.find((p) => p.as === "viewer" && p.type === "airforce.Aircraft")!;
    expect(viewerRead.values).toMatchObject({ maintenanceStatus: "withheld", readinessStatus: "withheld", needsAttention: "returned" });
    expect(before.probes.find((p) => p.as === "anonymous" && p.type === "airforce.Aircraft")?.outcome).toMatch(/refused|not-found/);
    const json = JSON.stringify(before);
    for (const value of ["FOB ALPHA", "Home station", "Block 50 F-16C assigned"]) expect(json).not.toContain(value);
  });

  it("without inspection, still records the reads, and says governance cannot be compared", async () => {
    const { runtime } = await buildAirforceWorkbench({ mockRestLatencyMs: 0 });
    const b = await recordBaseline(runtime, demoIdentities.maintainer, { callers });
    expect(b.inspection).toBeUndefined();
    const i = analyzeChange(b, b);
    expect([i.governance, i.observed, i.items]).toEqual(["unavailable", "compared", []]);
    expect(renderImpact(i)).toContain("Governance not compared: a baseline was recorded by someone who may not inspect.");
  });

  it("from a server, probes other subjects only for an inspector, and asks the directory nothing for anyone else", async () => {
    const { runtime } = await buildAirforceWorkbench({ mockRestLatencyMs: 0 });
    const asked: string[] = [];
    const people = [demoIdentities.viewer, demoIdentities.maintainer];
    const directory = {
      list: async () => (asked.push("list"), people.map((p) => ({ subjectId: p.subjectId }))),
      resolve: async (id: string) => (asked.push(id), people.find((p) => p.subjectId === id))
    };
    const viewers = await governedBaseline(runtime, demoIdentities.viewer, directory);
    expect([...new Set(viewers.probes.map((p) => p.as))]).toEqual([demoIdentities.viewer.subjectId]);
    expect(asked).toEqual([]);
    const lead = await governedBaseline(runtime, demoIdentities.lead, directory);
    expect([...new Set(lead.probes.map((p) => p.as))].sort()).toEqual([demoIdentities.lead.subjectId, demoIdentities.maintainer.subjectId, demoIdentities.viewer.subjectId].sort());
    expect(lead.probes.find((p) => p.as === demoIdentities.viewer.subjectId && p.type === "airforce.Aircraft")?.values.maintenanceStatus).toBe("withheld");
  });

  it("is checked before it is compared", () => {
    expect(isBaseline({ format: "typesys.baseline/1" })).toBe(false);
    expect(isBaseline({ ...before, probes: [{ as: 1 }] })).toBe(false);
    expect(isBaseline(null)).toBe(false);
    // To the depth a comparison reads it (5.0 pressure test): a malformed entry is refused, not crashed on.
    expect(isBaseline(before)).toBe(true);
    expect(isBaseline({ ...before, description: { ...before.description, types: [null] } })).toBe(false);
    expect(isBaseline({ ...before, description: { ...before.description, types: [{}] } })).toBe(false);
    expect(isBaseline({ ...before, inspection: { ...before.inspection!, types: [null] } })).toBe(false);
    expect(isBaseline({ ...before, probes: [{ as: "viewer", type: "t", id: "1", outcome: "allowed", values: { x: 1 } }] })).toBe(false);
  });

  it("compares only the values a probe records, never one found on the prototype (5.0 pressure test)", () => {
    const probe = before.probes.find((p) => p.as === "viewer")!;
    const forged = { ...before, probes: before.probes.map((p) => (p === probe ? { ...p, values: { ...p.values, constructor: "returned", toString: "returned" } } : p)) };
    expect(analyzeChange(forged as unknown as Baseline, before).items.map((i) => i.change).join("\n")).not.toMatch(/function|native code/);
  });
});

describe("analyzing a change", () => {
  it("finds the release that exposes maintenanceStatus to viewers, observed on a real read, and what it reaches", () => {
    const i = analyzeChange(before, after, consumers);
    expect(i.verdict).toBe("risky");
    expect(i.exposures.map((e) => [e.subject, e.as, e.change])).toEqual([["airforce.Aircraft.readinessStatus", "viewer", "now returned to viewer, was withheld"]]);
    const governance = i.items.find((x) => x.kind === "governance")!;
    expect(governance).toMatchObject({ subject: "airforce.Aircraft.readinessStatus", effect: "widens", basis: "predicted", node: "member:airforce.Aircraft.readinessStatus" });
    expect(governance.reaches.consumers).toEqual(expect.arrayContaining(["app:readiness-board", "workflow:airforce.GroundForRepair"]));
    expect(i.checks).toEqual(["part:app:readiness-board/check.viewer-withheld-readiness"]);
    // The maintainer read it before and after: no change for them.
    expect(i.items.some((x) => x.as === "maintainer")).toBe(false);
    expect(renderImpact(i)[0]).toMatch(/risky, 1 new exposure$/);
  });

  it("compares no read a source could not answer, and records a failed explanation as unavailable, not refused (5.0 pressure test)", async () => {
    const outage = structuredClone(before) as unknown as { probes: { as: string; values: Record<string, string> }[] };
    for (const p of outage.probes) if (p.as === "viewer") for (const k of Object.keys(p.values)) p.values[k] = "unavailable";
    const i = analyzeChange(outage as unknown as Baseline, before, consumers);
    expect(i.exposures).toEqual([]);
    expect(i.items.filter((x) => x.as === "viewer").every((x) => x.change.startsWith("not compared: a source was unavailable"))).toBe(true);
    const { runtime } = await buildAirforceWorkbench({ mockRestLatencyMs: 0 });
    const failing = { describeModel: runtime.describeModel.bind(runtime), query: runtime.query.bind(runtime), explain: async () => Promise.reject(new Error("source down")) };
    const b = await recordBaseline(failing, demoIdentities.lead, { callers: { viewer: demoIdentities.viewer }, types: ["airforce.Aircraft"] });
    expect(b.probes.map((p) => p.outcome)).toEqual(["unavailable"]);
  });

  it("finds nothing between a baseline and itself", () => {
    const i = analyzeChange(before, before, consumers);
    expect([i.verdict, i.items, i.exposures, i.checks]).toEqual(["compatible", [], [], []]);
  });

  it("classifies a removed value as breaking, and names what used it", async () => {
    const removed = {
      ...airforceManifest,
      types: airforceManifest.types.map((t) =>
        t.options.name === "airforce.Component" ? { ...t, schema: { ...t.schema, properties: Object.fromEntries(Object.entries(t.schema.properties ?? {}).filter(([k]) => k !== "condition")) } } : t
      )
    };
    const usesCondition: GraphConsumer = { kind: "app", name: "parts", uses: [], parts: [{ name: "data.poor", kind: "data", uses: [{ kind: "member", type: "airforce.Component", member: "condition", how: "filter" }] }] };
    const changed = await recordBaseline((await buildAirforceWorkbench({ mockRestLatencyMs: 0, manifest: removed })).runtime, demoIdentities.lead, { callers });
    const i = analyzeChange(before, changed, [usesCondition]);
    expect(i.verdict).toBe("breaking");
    const item = i.items.find((x) => x.kind === "contract" && x.subject === "airforce.Component.condition")!;
    expect(item.impact).toBe("breaking");
    expect(item.reaches.parts).toEqual(["part:app:parts/data.poor"]);
    expect(i.underVersioned.map((v) => v.subject)).toContain("airforce.Component");
  });
});

describe("governance differences", () => {
  const tweak = (fn: (i: { -readonly [K in keyof ModelInspection]: ModelInspection[K] }) => void): ModelInspection => {
    const copy = structuredClone(before.inspection!) as { -readonly [K in keyof ModelInspection]: ModelInspection[K] };
    fn(copy);
    return copy;
  };
  const member = (i: ModelInspection, name: string) => i.types.find((t) => t.name === "airforce.Aircraft")!.members.find((m) => m.name === name)! as unknown as { policy?: string; markings: string[] };

  it("a policy or marking taken away widens, one added narrows, a rule rewritten changes", () => {
    const g = diffGovernance(
      before.inspection!,
      tweak((i) => {
        delete member(i, "maintenanceStatus").policy;
        member(i, "deploymentLocation").markings = [];
        member(i, "tailNumber").policy = "airforce.maintainer-only";
        const p = i.policies.find((x) => x.name === "airforce.read-aircraft") as { rule?: string };
        p.rule = "true";
      })
    );
    expect(g).toEqual(
      expect.arrayContaining([
        { subject: "airforce.Aircraft.maintenanceStatus", change: "its read no longer guarded by airforce.maintainer-only", effect: "widens" },
        { subject: "airforce.Aircraft.deploymentLocation", change: "no longer marked SECRET", effect: "widens" },
        { subject: "airforce.Aircraft.tailNumber", change: "its read now guarded by airforce.maintainer-only", effect: "narrows" },
        expect.objectContaining({ subject: "policy:airforce.read-aircraft", effect: "changes" })
      ])
    );
  });

  it("an input added to a computed value narrows it, a marking on a relationship counts, and so do markings the recorder is not told of (5.0 pressure test)", () => {
    const aircraft = (i: ModelInspection) => i.types.find((t) => t.name === "airforce.Aircraft")! as unknown as { relationships: { name: string; markings: string[] }[]; withheldMarkings?: number };
    const computed = before.inspection!.types.find((t) => t.name === "airforce.Aircraft")!.members.find((m) => m.computed)!;
    const g = diffGovernance(
      before.inspection!,
      tweak((i) => {
        const c = member(i, computed.name) as unknown as { computed: { dependsOn: string[] } };
        c.computed.dependsOn = [...c.computed.dependsOn, "tailNumber"];
        aircraft(i).relationships[0]!.markings = ["SECRET"];
        aircraft(i).withheldMarkings = 1;
      })
    );
    const relationship = aircraft(before.inspection!).relationships[0]!.name;
    expect(g).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: `airforce.Aircraft.${computed.name}`, effect: "narrows", change: expect.stringContaining("now computed from tailNumber") as unknown }),
        { subject: `airforce.Aircraft.${relationship}`, change: "now marked SECRET", effect: "narrows" },
        { subject: "airforce.Aircraft", change: "1 marking you may not learn of, was 0", effect: "narrows" }
      ])
    );
  });

  it("names the graph node each subject is", () => {
    const m = before.description;
    expect(subjectNode("airforce.Aircraft", m)).toBe("type:airforce.Aircraft");
    expect(subjectNode("airforce.Aircraft.maintenance", m)).toBe("relationship:airforce.Aircraft.maintenance");
    expect(subjectNode("airforce.Aircraft.tailNumber", m)).toBe("member:airforce.Aircraft.tailNumber");
    expect(subjectNode("CreateMaintenanceWorkOrder.input.assignedTo", m)).toBe("action:CreateMaintenanceWorkOrder");
    expect(subjectNode("policy:airforce.read-aircraft", m)).toBe("policy:airforce.read-aircraft");
    expect(subjectNode("nothing.Here", m)).toBeUndefined();
  });
});
