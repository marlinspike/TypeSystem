import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createServer } from "../src/server.js";
import { buildObjectUri, buildProvenanceUri } from "../src/resource-uri.js";

/**
 * The AI-agent path gets the same classification enforcement as a direct
 * runtime call (ADR-0032): no MCP-side code exists to get it wrong.
 */
describe("MCP: classified values over the agent path (ADR-0032)", () => {
  it("the viewer's token never yields the SECRET deploymentLocation — by resource, provenance, or the query tool", async () => {
    const { server } = createServer(await buildAirforceTestbed(), resolveDemoIdentity);
    const client = new Client({ name: "classification-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const text = (r: { contents: unknown[] }) => (r.contents[0] as { text: string }).text;

    const asMaintainer = await client.readResource({ uri: buildObjectUri("airforce.Aircraft", "AF86-0147", "demo-maintainer-token") });
    expect(text(asMaintainer)).toContain("FOB ALPHA");

    const asViewer = await client.readResource({ uri: buildObjectUri("airforce.Aircraft", "AF86-0147", "demo-viewer-token") });
    expect(text(asViewer)).toContain("AF86-0147");
    expect(text(asViewer)).not.toContain("deploymentLocation");

    await expect(
      client.readResource({ uri: buildProvenanceUri("airforce.Aircraft", "AF86-0147", "deploymentLocation", "demo-viewer-token") })
    ).rejects.toThrow(/Not authorized/);

    const queried = await client.callTool({ name: "query", arguments: { type: "airforce.Aircraft", authToken: "demo-viewer-token" } });
    expect(JSON.stringify(queried)).not.toMatch(/FOB ALPHA|Home station/);
    await client.close();
  });
});
