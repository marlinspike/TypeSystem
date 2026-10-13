import { request } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { startHttpServer, type HttpTransportOptions, type RunningHttpServer } from "../src/http-transport.js";

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pressure", version: "1.0.0" } }
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
function post(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.write(INITIALIZE);
    req.end();
  });
}

describe("Origin checks (ADR-0053) under pressure", () => {
  it('allowedHosts "*" (documented as turning off only the Host check) also turns off the Origin check', async () => {
    const port = await start({ allowedHosts: "*" });
    // Holds regardless: a CORS "simple" request (text/plain essence) is refused by the SDK with 415.
    expect(await post(port, { host: "typesys.example.org", origin: "https://attacker.example", "content-type": "text/plain; application/json" })).not.toBe(200);
    // Not holding: any cross-site Origin passes the guard once allowedHosts is "*".
    expect(await post(port, { host: "typesys.example.org", origin: "https://attacker.example" })).toBe(403);
  });

  it("holds: trailing-dot, userinfo, and look-alike hosts and origins are refused", async () => {
    const port = await start();
    expect(await post(port, { host: "localhost." })).toBe(403);
    expect(await post(port, { host: "localhost@attacker.example" })).toBe(403);
    expect(await post(port, { host: "localhost.attacker.example" })).toBe(403);
    expect(await post(port, { host: "localhost", origin: "http://localhost.attacker.example" })).toBe(403);
    expect(await post(port, { host: "localhost", origin: "http://localhost@attacker.example" })).toBe(403);
    expect(await post(port, { host: "localhost", origin: "file://" })).toBe(403);
    expect(await post(port, { host: "LOCALHOST", origin: "HTTP://LOCALHOST:1" })).toBe(200);
  });
});
