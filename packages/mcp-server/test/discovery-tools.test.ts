import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createServer } from "../src/server.js";

/** `typesys_discover` and `typesys_validate_query` (ADR-0056): find, then check, then run. */
describe("discovery and validation over MCP (ADR-0056)", () => {
  let client: Client;

  beforeEach(async () => {
    const testbed = await buildAirforceTestbed();
    const { server } = createServer(testbed, resolveDemoIdentity);
    client = new Client({ name: "discovery-test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    await client.listTools(); // so the client validates structuredContent against each outputSchema
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  };

  it("answers a task with the few entries that matter, smaller than the full listing", async () => {
    const found = await call("typesys_discover", { task: "close a work order", limit: 2 });
    const matches = found.matches as { name: string; summary: string }[];
    expect(matches.map((m) => m.name)).toEqual(["UpdateWorkOrderStatus", "airforce.WorkOrder"]);
    const listed = await call("typesys_list_types", {});
    expect(JSON.stringify(found).length).toBeLessThan(JSON.stringify(listed).length / 10);
  });

  it("checks a query without running it, and names what was meant", async () => {
    const checked = await call("typesys_validate_query", { query: { type: "airforce.Aircraft", filter: { property: "readinesStatus", operator: "eq", value: "FMC" } } });
    expect(checked).toEqual({
      valid: false,
      diagnostics: [{ severity: "error", code: "unknown-property", path: "/filter/property", message: 'airforce.Aircraft has no value "readinesStatus"', suggestion: "readinessStatus" }]
    });
    expect(await call("typesys_validate_query", { query: { type: "airforce.Aircraft", filter: { property: "readinessStatus", operator: "eq", value: "FMC" } } })).toEqual({ valid: true, diagnostics: [] });
  });

  it("refuses a bad limit as a tool error", async () => {
    const result = await client.callTool({ name: "typesys_discover", arguments: { task: "x", limit: 0 } });
    expect(result.isError).toBe(true);
  });
});
