import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AbacPolicyEngine, InMemoryRegistryStore, SemanticRegistry, SemanticRuntime, allowAllRule, requireRole, type Adapter, type Identity } from "@typesys/core";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createServer } from "../src/server.js";

/** Pressure test 3 of ADR-0068 over MCP: nothing sent names what need-to-know withholds. */
async function connect(backend: { registry: SemanticRegistry; runtime: SemanticRuntime }, resolver: (t?: string | null) => Promise<Identity> | Identity) {
  const { server } = createServer(backend, resolver as never);
  const mcp = new Client({ name: "p3", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(c), server.connect(s)]);
  return mcp;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

class Store implements Adapter {
  readonly dataSourceId = "ds";
  async resolveProperties() {
    return { values: {}, provenance: [] };
  }
  async queryByType() {
    return { items: [] };
  }
  async resolveRelationship() {
    return [];
  }
  async executeAction() {
    return {};
  }
}

describe("p3: MCP under need-to-know (ADR-0068)", () => {
  it("P3-D7: typesys_explain_query is refused to an anonymous caller (stdio, no token) and names no withheld member to the viewer", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { discovery: "need-to-know" } });
    const mcp = await connect(tb, resolveDemoIdentity);
    const described = await mcp.callTool({ name: "typesys_describe_type", arguments: { type: "airforce.Aircraft" } });
    // Held: an anonymous caller is told no Type.
    expect(described.isError).toBe(true);
    const anonymous = await mcp.callTool({ name: "typesys_explain_query", arguments: { type: "airforce.Aircraft" } });
    const viewer = text(await mcp.callTool({ name: "typesys_explain_query", arguments: { type: "airforce.Aircraft", authToken: "demo-viewer-token" } }));
    await mcp.close();
    // Observed: the anonymous caller gets the plan; the viewer's names deploymentLocation, maintenanceStatus and readinessStatus.
    expect({
      anonymousRefused: anonymous.isError === true,
      viewerNames: ["deploymentLocation", "maintenanceStatus", "readinessStatus"].filter((n) => viewer.includes(n))
    }).toEqual({ anonymousRefused: true, viewerNames: [] });
  });

  it("P3-D8: typesys_describe_type's allowlisted `examples` keyword does not carry a withheld member's values", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registry.registerType(
      {
        $id: "https://typesys.dev/types/test/Public/1.0.0",
        type: "object",
        title: "Public",
        properties: { id: { type: "string" }, codename: { type: "string" } },
        examples: [{ id: "P-1", codename: "NIGHTJAR" }],
        "x-policy": { objectPolicy: "anyone", propertyPolicies: { codename: "secret.only" } }
      },
      { name: "test.Public", version: "1.0.0" }
    );
    await registry.registerMapping({ id: "m1", typeName: "test.Public", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
    const engine = new AbacPolicyEngine();
    engine.registerRule("anyone", allowAllRule);
    engine.registerRule("secret.only", requireRole("secret"));
    const runtime = new SemanticRuntime(registry, [new Store()], engine, { discovery: "need-to-know" });
    const viewer: Identity = { subjectId: "user-viewer", roles: ["viewer"], attributes: {} };
    const mcp = await connect({ registry, runtime }, () => viewer);
    const doc = text(await mcp.callTool({ name: "typesys_describe_type", arguments: { type: "test.Public", authToken: "t" } }));
    await mcp.close();
    // Held: the property itself is withheld from the schema's properties.
    expect((JSON.parse(doc) as { schema: { properties: Record<string, unknown> } }).schema.properties).not.toHaveProperty("codename");
    // Observed: "examples":[{"id":"P-1","codename":"NIGHTJAR"}].
    expect(doc).not.toContain("codename");
    expect(doc).not.toContain("NIGHTJAR");
  });
});
