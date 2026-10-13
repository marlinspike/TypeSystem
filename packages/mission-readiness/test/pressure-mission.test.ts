import type { Server } from "node:http";
import path from "node:path";
import type { Express } from "express";
import { describe, it, expect, afterAll } from "vitest";
import { buildMissionBackend, createComposedApp, createHandwrittenApp, type MissionBackend } from "../src/index.js";

const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

async function serve(create: (backend: MissionBackend, dir: string) => Express): Promise<string> {
  const app = create(await buildMissionBackend(), path.resolve(import.meta.dirname, "missing"));
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("pressure: mission servers on a malformed body", () => {
  for (const [label, create, p] of [
    ["composed", createComposedApp, "/api/query"],
    ["handwritten", createHandwrittenApp, "/app/work-orders/WO-1/status"]
  ] as const) {
    it(`${label}: answers 400 without a stack trace or server paths`, async () => {
      const base = await serve(create);
      const res = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer mission-lead-token" }, body: "{oops" });
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(text).not.toMatch(/node_modules|\/home\/|SyntaxError/);
    });
  }
});
