import { beforeAll, describe, expect, it } from "vitest";
import { AuthorizationError, type SemanticRuntime } from "@typesys/core";
import { buildAirforceWorkbench, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { workflowUses } from "../../workflow/src/uses.js";
import { compileContext, type CompiledContext, type ContextRuntime, type GraphConsumer } from "../src/index.js";

/**
 * Task-aware context (ADR-0092): every statement says how it is known,
 * selection is dependency-complete, what is built on the model is listed
 * with the Types it uses, and governance is shown only to an inspector.
 */
let runtime: SemanticRuntime;

beforeAll(async () => {
  ({ runtime } = await buildAirforceWorkbench({ mockRestLatencyMs: 0 }));
});

const TASK = "a page of aircraft that need attention";
const aircraft = (c: CompiledContext) => c.types.find((t) => t.name === "airforce.Aircraft")!;
const status = (c: CompiledContext, member: string) => aircraft(c).access!.find((a) => a.member === member)!;

/** A consumer of the kind `appUses` produces: data, a page showing it, and a check of the page. */
const board: GraphConsumer = {
  kind: "app",
  name: "readiness-board",
  uses: [],
  parts: [
    { name: "data.fleet", kind: "data", uses: [{ kind: "type", type: "airforce.Aircraft", how: "query" }, { kind: "member", type: "airforce.Aircraft", member: "needsAttention", how: "filter" }] },
    { name: "page.Board", kind: "page", uses: [{ kind: "part", part: "data.fleet", how: "shows" }] },
    { name: "check.viewer-sees-board", kind: "check", uses: [{ kind: "part", part: "page.Board", how: "screen" }] }
  ]
};

describe("statuses", () => {
  it("are verified by explaining the caller's own read: withheld values name only the control the caller may be told of", async () => {
    const c = await compileContext(runtime, demoIdentities.viewer, { task: TASK });
    expect(status(c, "needsAttention")).toEqual({ member: "needsAttention", status: "verified", note: "returned" });
    expect(status(c, "maintenanceStatus").status).toBe("withheld");
    expect(status(c, "maintenanceStatus").note).toContain("member-policy");
    expect(status(c, "deploymentLocation").status).toBe("withheld");
    expect(status(c, "deploymentLocation").note).toContain("classification");
    expect(status(c, "readinessStatus").status).toBe("withheld");
    expect(status(c, "readinessStatus").note).toContain("derivation");
    expect(c.text).toMatch(/maintenanceStatus\?: [^\n]*\[withheld: member-policy/);
    expect(c.text).not.toMatch(/needsAttention[^\n]*\[/);
  });

  it("without an explanation, a value absent from every probed object is inferred, never verified", async () => {
    const bare: ContextRuntime = { describeModel: (i) => runtime.describeModel(i), query: (q, i) => runtime.query(q, i), listActions: (t, i) => runtime.listActions(t, i) };
    const c = await compileContext(bare, demoIdentities.viewer, { task: TASK });
    expect(status(c, "maintenanceStatus").status).toBe("inferred");
    expect(status(c, "tailNumber").status).toBe("verified");
    expect(c.governance).toBe("withheld");
    expect(c.text).toMatch(/maintenanceStatus\?: [^\n]*\[inferred: not returned to this caller on \d+ probed\]/);
  });

  it("a refused read is withheld and a source that does not answer is unavailable, for every value of the Type", async () => {
    const failing = (error: Error): ContextRuntime => ({
      describeModel: (i) => runtime.describeModel(i),
      listActions: (t, i) => runtime.listActions(t, i),
      query: async (q, i) => {
        if (q.type === "airforce.Aircraft") throw error;
        return runtime.query(q, i);
      }
    });
    const refused = await compileContext(failing(new AuthorizationError("Not authorized", "no")), demoIdentities.viewer, { task: TASK });
    expect(new Set(aircraft(refused).access!.map((a) => a.status))).toEqual(new Set(["withheld"]));
    const down = await compileContext(failing(new Error("ECONNREFUSED 10.0.0.7:5432")), demoIdentities.viewer, { task: TASK });
    expect(new Set(aircraft(down).access!.map((a) => a.status))).toEqual(new Set(["unavailable"]));
    expect(down.text).toContain("[unavailable: the source did not answer the probe, for every value]");
    expect(down.text).not.toContain("ECONNREFUSED");
  });

  it("probe 0 reads nothing and claims nothing", async () => {
    const c = await compileContext(runtime, demoIdentities.viewer, { task: TASK, probe: 0 });
    expect(c.types.every((t) => t.access === undefined && t.visibility === undefined)).toBe(true);
    expect(c.text).not.toMatch(/: [^\n]*\[(withheld|inferred|unavailable):/);
  });
});

describe("governance", () => {
  it("is shown to an inspector: the policy, source and marking behind each value, and the inspection's digest", async () => {
    const c = await compileContext(runtime, demoIdentities.lead, { task: TASK });
    expect(c.governance).toBe("shown");
    expect(c.modelDigest).toBe((await runtime.inspectModel(demoIdentities.lead)).modelDigest);
    const guards = aircraft(c).guards!;
    expect(guards.members.find((m) => m.name === "maintenanceStatus")?.policy).toBe("airforce.maintainer-only");
    expect(guards.members.find((m) => m.name === "deploymentLocation")?.markings).toContain("SECRET");
    expect(guards.members.find((m) => m.name === "needsAttention")?.releases).toEqual(["maintenanceStatus"]);
    expect(c.text).toContain("{policy airforce.maintainer-only}");
  });

  it("is withheld from anyone else, who is told only that it is", async () => {
    const c = await compileContext(runtime, demoIdentities.viewer, { task: TASK, consumers: [workflowUses(groundForRepair as never)] });
    expect(c.governance).toBe("withheld");
    expect(c.types.every((t) => t.guards === undefined)).toBe(true);
    const json = JSON.stringify(c);
    // "SECRET" itself is in the description the viewer is told; the marking is not.
    for (const secret of ["airforce.maintainer-only", "airforce.read-aircraft", "in-memory-airforce-repo", "mock-remis-rest", "\"markings\"", "\"guards\"", "\"policy\"", "marked SECRET"]) expect(json).not.toContain(secret);
    expect(c.text).toContain("Sources, policies and markings are withheld from this caller.");
    expect(c.modelDigest).not.toBe((await runtime.inspectModel(demoIdentities.lead)).modelDigest);
  });
});

describe("selection is dependency-complete", () => {
  it("never keeps an Action without every Type it needs, at any budget, and says why it left one out", async () => {
    let sawNeeds = false;
    for (let maxTokens = 500; maxTokens <= 2_500; maxTokens += 100) {
      const c = await compileContext(runtime, demoIdentities.maintainer, { task: "open a work order against a maintenance event", focus: ["airforce.Aircraft", "CreateMaintenanceWorkOrder"], maxTokens, probe: 0 });
      const kept = new Set(c.types.map((t) => t.name));
      for (const a of c.actions) for (const t of a.needs) expect([maxTokens, a.name, kept.has(t)]).toEqual([maxTokens, a.name, true]);
      for (const l of c.leftOut.filter((x) => x.reason.startsWith("needs "))) {
        sawNeeds = true;
        expect(l.reason.slice("needs ".length).split(", ").some((t) => !kept.has(t))).toBe(true);
      }
      expect(c.omitted).toEqual(c.leftOut.map((l) => l.name));
      expect(c.tokens).toBeLessThanOrEqual(maxTokens);
    }
    expect(sawNeeds).toBe(true);
  });
});

describe("what is built on the model", () => {
  it("lists the parts that use a Type, and every check that reaches it, as checks a change must keep passing", async () => {
    const c = await compileContext(runtime, demoIdentities.maintainer, { task: TASK, consumers: [board, workflowUses(groundForRepair as never)] });
    const used = aircraft(c).usedBy;
    expect(used).toContainEqual({ consumer: "app readiness-board", part: "data.fleet", partKind: "data", how: "query" });
    expect(used).toContainEqual({ consumer: "app readiness-board", part: "data.fleet", partKind: "data", member: "needsAttention", how: "filter" });
    expect(used.some((u) => u.consumer === "workflow airforce.GroundForRepair" && u.partKind === "read")).toBe(true);
    expect(c.checks).toEqual([{ consumer: "app readiness-board", check: "check.viewer-sees-board" }]);
    expect(c.text).toContain("CHECKS a change must keep passing\n  app readiness-board: check.viewer-sees-board");
  });

  it("says a part that reads through undeclared code is unavailable, rather than that it uses nothing", async () => {
    const opaque: GraphConsumer = { kind: "workflow", name: "ops.Sweep", uses: [], parts: [{ name: "scan", kind: "read", uses: [], opaque: "a read step without `reads` may read any Type" }] };
    const c = await compileContext(runtime, demoIdentities.maintainer, { task: TASK, consumers: [opaque] });
    expect(c.opaque).toEqual(["part:workflow:ops.Sweep/scan"]);
    expect(c.text).toContain("[unavailable] whether these parts use the Types above: workflow:ops.Sweep/scan");
  });
});

describe("how to query and what to write", () => {
  it("sorts and searches on stored values only, with the runtime's page limit, and SDK lines that name only what exists", async () => {
    const c = await compileContext(runtime, demoIdentities.viewer, { task: TASK });
    const t = aircraft(c);
    expect(t.query.sortable).not.toContain("needsAttention");
    expect(t.query.sortable).toContain("tailNumber");
    expect(t.query.maxLimit).toBe(runtime.queryLimits.maxLimit);
    expect(t.sdk[0]).toMatch(/^client\.from\("airforce\.Aircraft"\)\.select\(("[a-zA-Z]+"(, )?)+\)\.limit\(20\)\.page\(\)$/);
    // Never selects a value the caller is withheld.
    expect(t.sdk[0]).not.toMatch(/maintenanceStatus|deploymentLocation/);
    const names = new Set([...t.values.map((v) => v.name), ...t.computed.map((x) => x.name)]);
    for (const m of t.sdk[0]!.matchAll(/"([a-zA-Z]+)"/g)) expect(names.has(m[1]!)).toBe(true);
    expect(c.actions.flatMap((a) => a.sdk)).toContain('client.action("CreateMaintenanceWorkOrder").invoke(input)');
    expect(c.text).toContain(`at most ${runtime.queryLimits.maxLimit} objects a page`);
  });
});
