import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { startHttpServer, type RunningHttpServer } from "../src/http-transport.js";

/** The `/healthz` and `/readyz` endpoints an orchestrator gates traffic on (ADR-0029). */
describe("HTTP health endpoints (ADR-0029)", () => {
  let server: RunningHttpServer;

  beforeAll(async () => {
    server = await startHttpServer(0, { backend: await buildAirforceTestbed(), identityResolver: resolveDemoIdentity }); // port 0 → any free port
  });
  afterAll(async () => {
    await server.close();
  });

  it("GET /healthz is 200 ok (liveness, no dependency checks)", async () => {
    const res = await fetch(`http://localhost:${server.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz is 200 ready when the registry store answers", async () => {
    const res = await fetch(`http://localhost:${server.port}/readyz`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: "ready" });
  });
});
