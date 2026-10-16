import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withAudience, describeModel } from "@typesys/core";
import { compactCatalog, compileContext } from "@typesys/devkit";
import { buildAirforceTestbed, demoAudiences, demoIdentities, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createServer } from "../src/server.js";

/**
 * The semantic context compiler (ADR-0078): what a coding task needs of
 * the model, as its caller is told of it and returned it. It is a read
 * like any other: decided by the runtime, for the person and the model
 * they read for.
 */
const MISSION = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../examples/missions/component-replacement/mission.json"), "utf8")) as { requirement: string; uses: { types: string[]; actions: string[] } };

describe("compileContext", () => {
  it("selects what a requirement needs: every Type and Action the hand-written mission uses", async () => {
    const { runtime } = await buildAirforceTestbed();
    const c = await compileContext(runtime, demoIdentities.maintainer, { task: MISSION.requirement });
    expect(c.types.map((t) => t.name)).toEqual(expect.arrayContaining(MISSION.uses.types));
    expect(c.actions.map((a) => a.name)).toEqual(expect.arrayContaining(MISSION.uses.actions));
    expect(c.text).toContain('status: "open" | "in-progress" | "closed"');
    expect(c.digest).toBe((await compileContext(runtime, demoIdentities.maintainer, { task: MISSION.requirement })).digest);
  });

  it("says which values were not returned to the caller, and shows examples only as the caller was returned them", async () => {
    const { runtime } = await buildAirforceTestbed();
    const viewer = await compileContext(runtime, demoIdentities.viewer, { task: "aircraft deployment location", examples: 2 });
    const aircraft = viewer.types.find((t) => t.name === "airforce.Aircraft")!;
    expect(aircraft.visibility!.neverReturned).toEqual(expect.arrayContaining(["maintenanceStatus", "deploymentLocation"]));
    expect(aircraft.examples!.every((e) => !("deploymentLocation" in e.values))).toBe(true);
    expect(viewer.text).not.toContain("FOB");
    const maintainer = await compileContext(runtime, demoIdentities.maintainer, { task: "aircraft deployment location", examples: 2 });
    expect(maintainer.types.find((t) => t.name === "airforce.Aircraft")!.visibility!.neverReturned).not.toContain("deploymentLocation");
  });

  it("reading for a model, the model's audience decides too: a SECRET person's agent on a CUI model is not shown SECRET values", async () => {
    const { runtime } = await buildAirforceTestbed();
    const agent = withAudience(demoIdentities.maintainer, demoAudiences.enclaveModel);
    const c = await compileContext(runtime, agent, { task: "aircraft deployment location", examples: 3 });
    expect(c.audience).toBe(demoAudiences.enclaveModel.id);
    expect(c.types.find((t) => t.name === "airforce.Aircraft")?.visibility?.neverReturned ?? ["deploymentLocation"]).toContain("deploymentLocation");
    expect(JSON.stringify(c)).not.toContain("FOB");
  });

  it("under need-to-know, is never told of what the caller may not learn of, and refuses an anonymous caller", async () => {
    const { runtime } = await buildAirforceTestbed({ runtimeOptions: { discovery: "need-to-know" } });
    const viewer = await compileContext(runtime, demoIdentities.viewer, { task: MISSION.requirement });
    const told = (await runtime.describeModel(demoIdentities.viewer)).types.map((t) => t.name);
    expect(viewer.types.every((t) => told.includes(t.name))).toBe(true);
    expect(viewer.actions.map((a) => a.name)).not.toContain("CreateMaintenanceWorkOrder");
    await expect(compileContext(runtime, demoIdentities.anonymous, { task: "aircraft" })).rejects.toThrow(/Not authorized/);
  });

  it("stays within its budget, says what it left out, and is smaller than the whole catalog on a narrow task", async () => {
    const { runtime, registry } = await buildAirforceTestbed();
    const small = await compileContext(runtime, demoIdentities.maintainer, { task: MISSION.requirement, maxTokens: 500 });
    expect(small.tokens).toBeLessThanOrEqual(500);
    expect(small.omitted.length).toBeGreaterThan(0);
    const narrow = await compileContext(runtime, demoIdentities.maintainer, { task: "close a work order", probe: 0 });
    expect(narrow.tokens).toBeLessThan(Math.ceil(compactCatalog(await describeModel(registry)).length / 4));
  });
});

describe("typesys_compile_context over MCP", () => {
  it("compiles for the caller whose token is on the call", async () => {
    const testbed = await buildAirforceTestbed();
    const { server } = createServer(testbed, resolveDemoIdentity);
    const client = new Client({ name: "context-test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    await client.listTools();
    const call = async (token: string) => (await client.callTool({ name: "typesys_compile_context", arguments: { task: "aircraft deployment location", examples: 1, authToken: token } })).structuredContent as { text: string; types: string[] };
    const viewer = await call("demo-viewer-token");
    expect(viewer.types).toContain("airforce.Aircraft");
    expect(viewer.text).toMatch(/deploymentLocation\?: string.*\[not returned to this caller\]/);
    expect((await call("demo-maintainer-token")).text).not.toMatch(/deploymentLocation\?: string.*\[not returned to this caller\]/);
    const bad = await client.callTool({ name: "typesys_compile_context", arguments: { task: "x", maxTokens: 10 } });
    expect(bad.isError).toBe(true);
  });
});
