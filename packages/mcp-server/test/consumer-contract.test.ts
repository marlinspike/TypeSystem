import { describe, it, expect, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { startHttpServer, type RunningHttpServer } from "../src/http-transport.js";

/** ADR-0103: an agent's contract, in a TypeSystem-Contract header or the server's default, governs every tool call it makes. */
describe("consumer contracts over MCP (Streamable HTTP)", () => {
  const running: RunningHttpServer[] = [];
  const clients: Client[] = [];
  afterAll(async () => {
    await Promise.allSettled([...clients.map((c) => c.close()), ...running.map((r) => r.close())]);
  });

  const connect = async (opts: { header?: string; serverContract?: Record<string, string> } = {}) => {
    const server = await startHttpServer(0, { backend: await buildAirforceTestbed(), identityResolver: resolveDemoIdentity, ...(opts.serverContract ? { contract: opts.serverContract } : {}) });
    running.push(server);
    const client = new Client({ name: "contract-test", version: "0.0.0" });
    const headers: Record<string, string> = { authorization: "Bearer demo-maintainer-token", ...(opts.header ? { "TypeSystem-Contract": opts.header } : {}) };
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/mcp`), { requestInit: { headers } }));
    clients.push(client);
    return { client, server };
  };
  const read = async (client: Client) => {
    const r = await client.callTool({ name: "typesys_get_object", arguments: { type: "airforce.Aircraft", id: "AF86-0147" } });
    return { isError: r.isError === true, text: (r.content as { text: string }[])[0]!.text };
  };

  it("serves a call within the agent's contract, and refuses one outside it", async () => {
    expect((await read((await connect({ header: "airforce.Aircraft@^1.0.0" })).client)).isError).toBe(false);
    const refused = await read((await connect({ header: "airforce.Aircraft@^2.0.0" })).client);
    expect(refused).toEqual({ isError: true, text: "The model does not satisfy this consumer's contract: airforce.Aircraft ^2.0.0" });
  });

  it("serves under the server's contract when the request sends none, and the request's own wins", async () => {
    expect((await read((await connect({ serverContract: { "airforce.Aircraft": "^2.0.0" } })).client)).isError).toBe(true);
    expect((await read((await connect({ serverContract: { "airforce.Aircraft": "^2.0.0" }, header: "airforce.Aircraft@1.x" })).client)).isError).toBe(false);
  });

  it("refuses a malformed header with a JSON-RPC error, before any tool runs", async () => {
    const server = await startHttpServer(0, { backend: await buildAirforceTestbed(), identityResolver: resolveDemoIdentity });
    running.push(server);
    const res = await fetch(`http://localhost:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "TypeSystem-Contract": "Aircraft@soon" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("Invalid TypeSystem-Contract header");
  });
});
