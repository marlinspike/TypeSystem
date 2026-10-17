import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requireRole } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, groundForRepair, resolveDemoIdentity } from "@typesys/domain-airforce";
import { workflowUses } from "@typesys/workflow";
import { createServer } from "../src/server.js";

/** typesys_inspect, typesys_explain and typesys_graph (ADR-0088, ADR-0089, ADR-0090): the workbench's questions for an agent. */
describe("workbench tools over MCP", () => {
  let client: Client;
  const PEOPLE = [demoIdentities.viewer, demoIdentities.maintainer];

  beforeAll(async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { inspection: { policy: "typesys.inspect" } } });
    (tb.policyEngine as unknown as { registerRule(n: string, r: unknown): void }).registerRule("typesys.inspect", requireRole("lead"));
    const { server } = createServer({ ...tb, consumers: [workflowUses(groundForRepair)], subjects: { list: async () => PEOPLE, resolve: async (id) => PEOPLE.find((p) => p.subjectId === id) } }, resolveDemoIdentity);
    client = new Client({ name: "workbench-test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    await client.listTools();
  });

  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
    return r.structuredContent as Record<string, unknown>;
  };

  it("lists the three tools as read-only", async () => {
    const tools = (await client.listTools()).tools.filter((t) => ["typesys_inspect", "typesys_explain", "typesys_graph"].includes(t.name));
    expect(tools).toHaveLength(3);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("inspects for an inspector and refuses anyone else", async () => {
    const i = await ok("typesys_inspect", { types: ["airforce.Aircraft"], authToken: "demo-lead-token" });
    expect((i.types as { name: string }[])[0]!.name).toBe("airforce.Aircraft");
    expect((await call("typesys_inspect", { authToken: "demo-viewer-token" })).isError).toBe(true);
  });

  it("explains a caller's own read, and another subject's for an inspector only", async () => {
    const q = { kind: "read", type: "airforce.Aircraft", id: "AF86-0147" };
    expect(await ok("typesys_explain", { question: q, authToken: "demo-viewer-token" })).toMatchObject({ outcome: "partial", disclosure: "caller" });
    expect(await ok("typesys_explain", { question: q, as: demoIdentities.viewer.subjectId, authToken: "demo-lead-token" })).toMatchObject({ disclosure: "inspector", subject: demoIdentities.viewer.subjectId });
    const refused = await call("typesys_explain", { question: q, as: "nobody", authToken: "demo-viewer-token" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).not.toContain("No subject");
  });

  it("answers what a change to a value reaches, through the workflow built on it", async () => {
    const reach = await ok("typesys_graph", { view: "dependents", node: "member:airforce.Aircraft.maintenanceStatus", authToken: "demo-lead-token" });
    expect(reach.consumers).toEqual(["workflow:airforce.GroundForRepair"]);
    const overview = await ok("typesys_graph", { authToken: "demo-viewer-token" });
    expect(overview.structure).toBe("description");
    expect((await call("typesys_graph", { view: "dependents", node: "type:nope", authToken: "demo-lead-token" })).isError).toBe(true);
  });

  it("typesys_compile_context marks each value's status and lists the workflow steps on a Type the server knows of (ADR-0092)", async () => {
    const viewer = await ok("typesys_compile_context", { task: "aircraft that need attention", authToken: "demo-viewer-token" });
    const access = (viewer.access as Record<string, { member: string; status: string }[]>)["airforce.Aircraft"]!;
    expect(access.find((a) => a.member === "maintenanceStatus")?.status).toBe("withheld");
    expect(viewer.governance).toBe("withheld");
    expect(viewer.text).toContain("used by workflow airforce.GroundForRepair");
    const lead = await ok("typesys_compile_context", { task: "aircraft that need attention", authToken: "demo-lead-token" });
    expect(lead.governance).toBe("shown");
    expect(lead.text).toContain("airforce.maintainer-only");
  });

  it("typesys_impact records a baseline and compares one, as the caller may learn the model (ADR-0093)", async () => {
    const baseline = await ok("typesys_impact", { authToken: "demo-lead-token" });
    expect(baseline.format).toBe("typesys.baseline/1");
    expect(new Set((baseline.probes as { as: string }[]).map((p) => p.as)).size).toBe(3);
    const same = await ok("typesys_impact", { baseline, authToken: "demo-lead-token" });
    expect(same).toMatchObject({ verdict: "compatible", items: [] });
    const viewer = await ok("typesys_impact", { authToken: "demo-viewer-token" });
    expect(new Set((viewer.probes as { as: string }[]).map((p) => p.as))).toEqual(new Set([demoIdentities.viewer.subjectId]));
    expect((await call("typesys_impact", { baseline: { format: "nope" }, authToken: "demo-lead-token" })).isError).toBe(true);
  });
});
