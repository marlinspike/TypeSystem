import { request } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { startHttpServer, type HttpTransportOptions, type RunningHttpServer } from "../src/http-transport.js";

/**
 * DNS-rebinding protection on the HTTP transport (ADR-0053): `/mcp` answers
 * only to an allowed Host, and to a browser only from an allowed Origin.
 * Raw `node:http`, since `fetch` won't let a test set `Host`.
 */
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "origin-test", version: "1.0.0" } }
});

let running: RunningHttpServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(extra: Partial<HttpTransportOptions> = {}): Promise<number> {
  running = await startHttpServer(0, { backend: await buildAirforceTestbed(), identityResolver: resolveDemoIdentity, ...extra });
  return running.port;
}

function post(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: path === "/mcp" ? "POST" : "GET", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    if (path === "/mcp") req.write(INITIALIZE);
    req.end();
  });
}

describe("Host and Origin checks on /mcp (ADR-0053)", () => {
  it("answers localhost by default, with or without a port, and a non-browser client sending no Origin", async () => {
    const port = await start();
    expect(await post(port, "/mcp", { host: `localhost:${port}` })).toBe(200);
    expect(await post(port, "/mcp", { host: "127.0.0.1" })).toBe(200);
    expect(await post(port, "/mcp", { host: `[::1]:${port}` })).toBe(200);
  });

  it("refuses a rebinding Host, and a browser Origin on another host", async () => {
    const port = await start();
    expect(await post(port, "/mcp", { host: "attacker.example" })).toBe(403);
    expect(await post(port, "/mcp", { host: `localhost:${port}`, origin: "http://attacker.example" })).toBe(403);
    expect(await post(port, "/mcp", { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(200);
    expect(await post(port, "/mcp", { host: `localhost:${port}`, origin: "null" })).toBe(403);
  });

  it("serves a deployment's own host names, and only those", async () => {
    const port = await start({ allowedHosts: ["typesys.example.org"] });
    expect(await post(port, "/mcp", { host: "typesys.example.org" })).toBe(200);
    expect(await post(port, "/mcp", { host: `localhost:${port}` })).toBe(403);
    expect(await post(port, "/mcp", { host: "typesys.example.org", origin: "https://typesys.example.org" })).toBe(200);
  });

  it("checks Origin against an explicit list when given one", async () => {
    const port = await start({ allowedOrigins: ["https://console.example.org"] });
    expect(await post(port, "/mcp", { host: "localhost", origin: "https://console.example.org" })).toBe(200);
    expect(await post(port, "/mcp", { host: "localhost", origin: `http://localhost:${port}` })).toBe(403);
  });

  it("leaves the health endpoints to the orchestrator, whatever Host it sends", async () => {
    const port = await start();
    expect(await post(port, "/healthz", { host: "10.0.0.7:3939" })).toBe(200);
    expect(await post(port, "/readyz", { host: "10.0.0.7:3939" })).toBe(200);
  });

  it('turns the Host check off only when told "*"', async () => {
    const port = await start({ allowedHosts: "*" });
    expect(await post(port, "/mcp", { host: "anything.internal" })).toBe(200);
  });
});
