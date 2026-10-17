import { describe, it, expect } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ResolvedObject, SemanticAggregateQuery } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, resolveDemoIdentity, type AirforceModel } from "@typesys/domain-airforce";
import { createServer } from "@typesys/mcp-server";
import { createClient, mcpTransport, runtimeTransport, toRow, type Transport } from "../src/index.js";

const BY_MODEL = { type: "airforce.Aircraft", groupBy: ["model"], aggregations: [{ name: "n", op: "count" }] } satisfies SemanticAggregateQuery & { type: "airforce.Aircraft" };

describe("SDK aggregates and unavailable parts (ADR-0081)", () => {
  it("returns the runtime's own groups, in process and over MCP", async () => {
    const testbed = await buildAirforceTestbed();
    const { server } = createServer(testbed, resolveDemoIdentity);
    const mcp = new McpClient({ name: "sdk-aggregate", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(a), server.connect(b)]);
    const direct = await testbed.runtime.aggregate(BY_MODEL, demoIdentities.maintainer);
    expect(direct.groups.length).toBeGreaterThan(0);
    expect(await createClient<AirforceModel>(runtimeTransport(testbed.runtime, demoIdentities.maintainer)).aggregate(BY_MODEL)).toEqual(direct);
    expect(await createClient<AirforceModel>(mcpTransport(mcp, { authToken: "demo-maintainer-token" })).aggregate(BY_MODEL)).toEqual(direct);
  });

  it("refuses plainly on a transport that does not carry aggregates", async () => {
    const testbed = await buildAirforceTestbed();
    const older: Transport = { ...runtimeTransport(testbed.runtime, demoIdentities.maintainer), aggregate: undefined };
    await expect(createClient<AirforceModel>(older).aggregate(BY_MODEL)).rejects.toThrow(/does not carry aggregates/);
  });

  it("says which parts of a row are unavailable, and nothing when none are", () => {
    const base = { type: "airforce.Aircraft", id: "AF86-0147", properties: { tailNumber: "AF86-0147" } } as unknown as ResolvedObject;
    expect(toRow(base, [], false)).not.toHaveProperty("$unavailable");
    const part = { path: "maintenance", dataSourceId: "maintenance-api", reason: "unavailable", message: "source failed" };
    expect(toRow({ ...base, unavailable: [part] } as unknown as ResolvedObject, [], false).$unavailable).toEqual([part]);
  });
});
