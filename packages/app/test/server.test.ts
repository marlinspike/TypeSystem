import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { WorkflowEngine } from "@typesys/workflow";
import { applicationApp } from "../src/server.js";

/**
 * ADR-0123: an application a deployment hosts is reached by the names the
 * deployment's own server is, and signs callers in the same way. Before,
 * it answered only to localhost, so behind a real host name every request
 * was refused.
 */
describe("applicationApp", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const backend = await buildAirforceTestbed();
    const workflows = await WorkflowEngine.create({ host: backend });
    const app = applicationApp({
      backend,
      identities: resolveDemoIdentity,
      workflows,
      allowedHosts: ["app.example.com"],
      signIn: { issuer: "https://login.example.com", resource: "https://app.example.com" }
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = async (host: string, token?: string) => {
    const { request } = await import("node:http");
    return new Promise<{ status: number; challenge?: string }>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path: "/api/me", headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode!, ...(typeof res.headers["www-authenticate"] === "string" ? { challenge: res.headers["www-authenticate"] } : {}) });
      })
        .on("error", reject)
        .end();
    });
  };

  it("answers to the deployment's host names, and only to them", async () => {
    expect((await get("app.example.com", "demo-maintainer-token")).status).toBe(200);
    expect((await get("evil.example.com", "demo-maintainer-token")).status).toBe(403);
  });

  it("challenges a request with no token, as the deployment's own API does", async () => {
    const res = await get("app.example.com");
    expect(res.status).toBe(401);
    expect(res.challenge).toContain('resource_metadata="https://app.example.com/.well-known/oauth-protected-resource"');
  });
});
