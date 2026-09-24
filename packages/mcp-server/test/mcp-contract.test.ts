import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type TypeSysMcpServer } from "../src/server.js";
import { buildTypeUri, buildObjectUri, buildRelationshipUri, buildProvenanceUri } from "../src/resource-uri.js";

function jsonOf(result: { contents: { text?: string }[] }): unknown {
  return JSON.parse(result.contents[0]!.text!);
}

describe("MCP contract — the vertical slice's discover -> inspect -> retrieve -> navigate -> provenance -> act script", () => {
  let bundle: TypeSysMcpServer;
  let client: Client;

  beforeEach(async () => {
    bundle = await createServer();
    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), bundle.server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
  });

  it("1. discovers an Aircraft via resources/list", async () => {
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === buildObjectUri("airforce.Aircraft", "AF86-0147"))).toBe(true);
  });

  it("2. inspects the Aircraft's semantic definition (relationships, computed properties)", async () => {
    const result = await client.readResource({ uri: buildTypeUri("airforce.Aircraft") });
    const typeDoc = jsonOf(result) as { relationships: { name: string }[]; computedPropertyNames: string[] };
    expect(typeDoc.relationships.map((r) => r.name).sort()).toEqual(["components", "maintenance"]);
    expect(typeDoc.computedPropertyNames).toContain("readinessStatus");
  });

  it("3. retrieves the Aircraft object", async () => {
    const result = await client.readResource({ uri: buildObjectUri("airforce.Aircraft", "AF86-0147", "demo-maintainer-token") });
    const object = jsonOf(result) as { values: Record<string, unknown> };
    expect(object.values.tailNumber).toBe("AF86-0147");
    expect(object.values.readinessStatus).toBe("PMC");
  });

  it("4. navigates to its components and maintenance history", async () => {
    const components = jsonOf(
      await client.readResource({ uri: buildRelationshipUri("airforce.Aircraft", "AF86-0147", "components", "demo-maintainer-token") })
    ) as { objectId: string }[];
    expect(components).toHaveLength(2);

    const maintenance = jsonOf(
      await client.readResource({ uri: buildRelationshipUri("airforce.Aircraft", "AF86-0147", "maintenance", "demo-maintainer-token") })
    ) as { objectId: string }[];
    expect(maintenance).toHaveLength(2);
  });

  it("5. understands provenance for a resolved property", async () => {
    const provenance = jsonOf(
      await client.readResource({
        uri: buildProvenanceUri("airforce.Aircraft", "AF86-0147", "maintenanceStatus", "demo-maintainer-token")
      })
    ) as { source: { system: string } }[];
    expect(provenance[0]?.source.system).toBe("airforce-repo");
  });

  it("6. discovers available Actions via tools/list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("CreateMaintenanceWorkOrder");
    expect(tools.map((t) => t.name)).toContain("query");
  });

  it("7. invokes an authorized test Action, and the same tool denies an unauthorized caller in the very next call", async () => {
    const authorized = await client.callTool({
      name: "CreateMaintenanceWorkOrder",
      arguments: { maintenanceEventId: "EVT-9002", assignedTo: "SrA Chen", authToken: "demo-maintainer-token" }
    });
    expect(authorized.isError).not.toBe(true);

    // Same connection, no session/cache reuse: a different bearer token on the very next
    // call must be re-evaluated independently and produce a different outcome (see ADR-0012).
    const unauthorized = await client.callTool({
      name: "CreateMaintenanceWorkOrder",
      arguments: { maintenanceEventId: "EVT-9001", assignedTo: "SrA Chen", authToken: "demo-viewer-token" }
    });
    expect(unauthorized.isError).toBe(true);
  });
});
