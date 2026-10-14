import type { Server as HttpServer } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AbacPolicyEngine, InMemoryRegistryStore, SemanticRegistry, SemanticRuntime, allowAllRule, requireRole, type Adapter, type Identity } from "@typesys/core";
import { createApiApp } from "@typesys/http";
import { buildAirforceTestbed, resolveDemoIdentity, type AirforceTestbed } from "@typesys/domain-airforce";
import { createServer } from "../src/server.js";

/** Adversarial review of ADR-0068 over MCP and REST. Each test asserts the secure behavior. */
async function connect(backend: { registry: SemanticRegistry; runtime: SemanticRuntime }, resolver: (t?: string | null) => Promise<Identity> | Identity) {
  const { server } = createServer(backend, resolver as never);
  const mcp = new Client({ name: "adv", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(c), server.connect(s)]);
  return mcp;
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content)[0]!.text;

describe("ADR-0068 adversarial over MCP and REST (airforce, need-to-know)", () => {
  let tb: AirforceTestbed;
  let mcp: Client;
  let api: HttpServer;
  let base: string;
  beforeAll(async () => {
    tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { discovery: "need-to-know" } });
    mcp = await connect(tb, resolveDemoIdentity);
    const app = createApiApp({ backend: tb, identityResolver: resolveDemoIdentity, onError: () => {} });
    await new Promise<void>((r) => (api = app.listen(0, "127.0.0.1", () => r())));
    base = `http://127.0.0.1:${(api.address() as { port: number }).port}/api`;
  });
  afterAll(async () => {
    await mcp.close();
    await new Promise<void>((r) => api.close(() => r()));
  });

  it("typesys_describe_type does not name the viewer's withheld base Type core.Asset (schema.allOf $ref)", async () => {
    const model = await tb.runtime.describeModel(await resolveDemoIdentity("demo-viewer-token"));
    expect(model.types.find((t) => t.name === "airforce.Aircraft")?.extends).toBeUndefined(); // withheld by the runtime
    const described = text(await mcp.callTool({ name: "typesys_describe_type", arguments: { type: "airforce.Aircraft", authToken: "demo-viewer-token" } }));
    expect(described).not.toMatch(/core[./]Asset/);
  });

  it("REST: a viewer refused a withheld Action is not told which roles its policy wants", async () => {
    const res = await fetch(`${base}/actions/CreateMaintenanceWorkOrder/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer demo-viewer-token" },
      body: JSON.stringify({ maintenanceEventId: "EVT-9002", assignedTo: "x" })
    });
    const body = await res.text();
    expect(res.status).toBe(403);
    expect(body).not.toContain("ai-enclave");
  });

  it("REST/MCP: preview of a withheld Action tells a viewer nothing beyond what an unknown Action gets", async () => {
    const res = await fetch(`${base}/actions/CreateMaintenanceWorkOrder/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer demo-viewer-token" },
      body: JSON.stringify({ maintenanceEventId: "EVT-9002", assignedTo: "x" })
    });
    const body = await res.text();
    expect(body).not.toContain("The referenced maintenance event must exist");
    expect(body).not.toContain("ai-enclave");
  });

  it("REST: an anonymous caller is refused previewAction in need-to-know, as it is listActions", async () => {
    const list = await fetch(`${base}/types/airforce.MaintenanceEvent/actions`);
    expect(list.status).toBe(403);
    const preview = await fetch(`${base}/actions/CreateMaintenanceWorkOrder/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(preview.status).not.toBe(200);
  });
});

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

describe("ADR-0068 adversarial over MCP (custom model, need-to-know)", () => {
  let mcp: Client;
  beforeAll(async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registry.registerType(
      { $id: "https://typesys.dev/types/test/Compartment/1.0.0", type: "object", title: "Compartment", properties: { id: { type: "string" } }, "x-policy": { objectPolicy: "secret.only" } },
      { name: "test.Compartment", version: "1.0.0" }
    );
    await registry.registerType(
      {
        $id: "https://typesys.dev/types/test/Public/1.0.0",
        type: "object",
        title: "Public",
        properties: { id: { type: "string" } },
        "x-relationships": {
          peer: { target: "test.Public", cardinality: "many-to-many", inverse: "handlerOfRecord", resolution: { dataSourceId: "ds", operation: "peers" } },
          handlerOfRecord: { target: "test.Public", cardinality: "many-to-one", resolution: { dataSourceId: "ds", operation: "handler" } }
        },
        "x-policy": { objectPolicy: "anyone", propertyPolicies: { handlerOfRecord: "secret.only" } }
      } as never,
      { name: "test.Public", version: "1.0.0", deprecated: { since: "1.0.0", supersededBy: "test.Compartment" } }
    );
    const engine = new AbacPolicyEngine();
    engine.registerRule("anyone", allowAllRule);
    engine.registerRule("secret.only", requireRole("secret"));
    const runtime = new SemanticRuntime(registry, [new Store()], engine, { discovery: "need-to-know" });
    const viewer: Identity = { subjectId: "user-viewer", roles: ["viewer"], attributes: {} };
    const sanity = await runtime.describeModel(viewer);
    if (JSON.stringify(sanity.types.map((t) => [t.name, t.relationships.map((r) => r.name)])) !== JSON.stringify([["test.Public", ["peer"]]])) throw new Error(`unexpected model ${JSON.stringify(sanity)}`);
    mcp = await connect({ registry, runtime }, () => viewer);
  });
  afterAll(() => mcp.close());

  it("typesys_describe_type does not name a withheld relationship through another one's inverseName", async () => {
    const described = text(await mcp.callTool({ name: "typesys_describe_type", arguments: { type: "test.Public" } }));
    expect(described).not.toContain("handlerOfRecord");
  });

  it("typesys_describe_type does not name a withheld Type through deprecated.supersededBy", async () => {
    const described = text(await mcp.callTool({ name: "typesys_describe_type", arguments: { type: "test.Public" } }));
    expect(described).not.toContain("test.Compartment");
  });

  it("typesys_validate_query does not suggest a withheld Type", async () => {
    const r = text(await mcp.callTool({ name: "typesys_validate_query", arguments: { query: { type: "test.Public" } } }));
    expect(r).not.toContain("test.Compartment");
  });
});
