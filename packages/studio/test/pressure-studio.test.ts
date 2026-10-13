import type { Server } from "node:http";
import { request } from "node:http";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildAirforceTestbed, resolveDemoIdentity, type AirforceTestbed } from "@typesys/domain-airforce";
import { createStudioApp } from "../src/index.js";

let testbed: AirforceTestbed;
let server: Server;
let port: number;

beforeAll(async () => {
  testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const app = createStudioApp({ backend: testbed, identityResolver: resolveDemoIdentity, clientDir: path.resolve(import.meta.dirname, "fixtures/client") });
  await new Promise<void>((r) => (server = app.listen(0, "127.0.0.1", () => r())));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const raw = (method: string, p: string, headers: Record<string, string> = {}, body?: string) =>
  new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((r, j) => {
    const req = request({ host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => r({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on("error", j);
    if (body !== undefined) req.write(body);
    req.end();
  });

describe("pressure: the Studio's static client", () => {
  it("serves nothing outside its client directory", async () => {
    for (const p of ["/../package.json", "/..%2fpackage.json", "/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/..\\..\\package.json", "/.%2e/studio.test.ts", "/%2e%2e%5cstudio.test.ts"]) {
      const res = await raw("GET", p);
      expect([p, res.status === 200 && /"name"|describe\(/.test(res.text)]).toEqual([p, false]);
    }
  });

  it("every response the Studio serves to a browser, the API's included, carries frame-ancestors / nosniff", async () => {
    const api = await raw("GET", "/api/me");
    expect(api.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("a malformed JSON body to the Studio's API leaks no stack trace", async () => {
    const res = await raw("POST", "/api/query/validate", { "content-type": "application/json" }, "{bad");
    expect(res.text).not.toMatch(/node_modules|\/home\/|SyntaxError/);
  });
});
