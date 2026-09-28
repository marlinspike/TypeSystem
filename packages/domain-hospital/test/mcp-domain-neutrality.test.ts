import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerResourceHandlers, registerToolHandlers, type IdentityResolver } from "@typesys/mcp-server";
import { buildHospitalTestbed, hospitalDemoIdentities } from "../src/setup.js";

// mcp-server's own `resolveDemoIdentity` maps tokens onto *airforce's* demo
// identities (maintainer/viewer) — not usable here, since this domain's
// policy rules require a "clinician"/"patient"/"admin" role instead. Supplying
// a domain-appropriate `IdentityResolver` is exactly what a real deployment
// does (see ADR-0018); it's a plain parameter, never fixed to one domain.
const resolveHospitalIdentity: IdentityResolver = async (token) =>
  token === "clinician" ? hospitalDemoIdentities.clinician : hospitalDemoIdentities.anonymous;

/**
 * Proves docs/developer-guide/adding-a-domain.md's central claim with real
 * MCP protocol machinery, not just a registry-level assertion: `resources.ts`/
 * `tools.ts` are generic over whatever registry/runtime they're given — they
 * were built against `packages/domain-airforce`, but nothing about them is
 * airforce-specific. Registering `hospitalManifest` and pointing the exact
 * same handler-registration functions at it, with zero changes to either
 * file, makes `hospital.Patient` immediately browsable over a real MCP
 * connection (see ADR-0013).
 */
describe("hospital domain is browsable over real MCP, using mcp-server's handlers unmodified", () => {
  async function connect() {
    const { registry, runtime } = await buildHospitalTestbed();
    const server = new Server({ name: "hospital-mcp-test", version: "0.0.0" }, { capabilities: { resources: {}, tools: {} } });
    registerResourceHandlers(server, registry, runtime, resolveHospitalIdentity);
    registerToolHandlers(server, registry, runtime, resolveHospitalIdentity);

    const client = new Client({ name: "hospital-mcp-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return client;
  }

  it("lists hospital.Provider as a browsable MCP resource", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === "typesys://types/hospital.Patient")).toBe(true);
    expect(resources.some((r) => r.uri === "typesys://types/hospital.Provider")).toBe(true);
    expect(resources.some((r) => r.uri === "typesys://types/hospital.Appointment")).toBe(true);
    await client.close();
  });

  it("reads a hospital.Provider object over MCP (public — no token needed)", async () => {
    const client = await connect();
    const result = await client.readResource({ uri: "typesys://objects/hospital.Provider/PR-2001" });
    const object = JSON.parse((result.contents[0] as { text: string }).text) as { values: Record<string, unknown> };
    expect(object.values.displayName).toBe("Dr. Priya Nair");
    await client.close();
  });

  it("the generic `query` tool works against hospital.Appointment with no MCP-side changes", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("query");

    const result = await client.callTool({
      name: "query",
      arguments: { type: "hospital.Appointment", authToken: "clinician" }
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "null";
    const parsed = JSON.parse(text) as { items: unknown[] };
    expect(parsed.items).toHaveLength(3);
    await client.close();
  });
});
