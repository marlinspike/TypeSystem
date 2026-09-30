import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type TypeSysMcpServer } from "../src/server.js";
import { buildTypeUri, buildObjectUri, buildRelationshipUri, buildProvenanceUri } from "../src/resource-uri.js";

/** MCP resource contents are either text or binary (`blob`); every resource here is JSON text. */
function jsonOf(result: { contents: ({ text: string } | { blob: string })[] }): unknown {
  const first = result.contents[0];
  if (!first || !("text" in first)) throw new Error("expected a text resource");
  return JSON.parse(first.text);
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

  it("8. advertises the query tool's real schema and limits, and rejects over-limit or malformed queries", async () => {
    const { tools } = await client.listTools();
    const queryTool = tools.find((t) => t.name === "query")!;
    const props = queryTool.inputSchema.properties as Record<string, { maximum?: number }>;
    expect(props.limit?.maximum).toBe(bundle.runtime.queryLimits.maxLimit);
    expect(props.authToken).toBeDefined();

    const ok = await client.callTool({ name: "query", arguments: { type: "airforce.Aircraft", limit: 1, authToken: "demo-maintainer-token" } });
    expect(ok.isError).not.toBe(true);

    const overLimit = await client.callTool({
      name: "query",
      arguments: { type: "airforce.Aircraft", limit: bundle.runtime.queryLimits.maxLimit + 1, authToken: "demo-maintainer-token" }
    });
    expect(overLimit.isError).toBe(true);

    const malformed = await client.callTool({
      name: "query",
      arguments: { type: "airforce.Aircraft", filter: { property: "tailNumber", operator: "regex", value: ".*" }, authToken: "demo-maintainer-token" }
    });
    expect(malformed.isError).toBe(true);
  });

  it("9. rejects Action input that doesn't match the Action's inputSchema", async () => {
    const result = await client.callTool({
      name: "CreateMaintenanceWorkOrder",
      arguments: { maintenanceEventId: "EVT-9002", authToken: "demo-maintainer-token" }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/assignedTo/);
  });

  it("10. tells an agent it may not read a Type, rather than returning a result that reads as 'nothing exists' (ADR-0049)", async () => {
    // No token: the anonymous identity holds no role, so the Aircraft read policy admits nothing of the Type for it.
    const refused = await client.callTool({ name: "query", arguments: { type: "airforce.Aircraft" } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("Not authorized: read airforce.Aircraft");
    expect(JSON.stringify(refused.content)).not.toContain("items");

    const allowed = await client.callTool({ name: "query", arguments: { type: "airforce.Aircraft", authToken: "demo-viewer-token" } });
    expect(allowed.isError).not.toBe(true);
    expect(JSON.stringify(allowed.content)).toContain("AF86-0147");
  });

  it("11. an object that does not exist is an error naming it, not an empty object — and only for a caller who may read the Type (ADR-0048)", async () => {
    await expect(client.readResource({ uri: buildObjectUri("airforce.Aircraft", "NOPE-0000", "demo-maintainer-token") })).rejects.toThrow(/Not found: airforce\.Aircraft\/NOPE-0000/);
    // Anonymous is refused before the runtime says whether the id exists, so the refusal tells it nothing about an id.
    const messageOf = (read: Promise<unknown>) => read.then(() => "(read succeeded)", (e: Error) => e.message);
    const refusedExisting = await messageOf(client.readResource({ uri: buildObjectUri("airforce.Aircraft", "AF86-0147") }));
    const refusedMissing = await messageOf(client.readResource({ uri: buildObjectUri("airforce.Aircraft", "NOPE-0000") }));
    expect(refusedExisting).toMatch(/Not authorized/);
    expect(refusedMissing.replace("NOPE-0000", "ID")).toBe(refusedExisting.replace("AF86-0147", "ID"));
  });
});
