import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { clientRouter } from "../src/index.js";

let server: Server;
let base: string;

beforeAll(async () => {
  // Under a folder whose name starts with a dot, as an application checked out in ~/.local or a .work folder is.
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "spa-")), ".work", "app");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(path.join(dir, "app.js"), "console.log(1)");
  const app = express();
  app.use("/api", (_req, res) => void res.status(404).json({ error: "no such route" }));
  app.use(clientRouter({ dir, spa: true }));
  await new Promise<void>((r) => (server = app.listen(0, "127.0.0.1", () => r())));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const html = { accept: "text/html" };

describe("clientRouter spa (ADR-0081)", () => {
  it("answers a deep link with index.html, so the client's router takes it", async () => {
    const res = await fetch(`${base}/shipments/S-1`, { headers: html });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("id=root");
  });
  it("still serves real files, and never answers a missing file or an API path with the page", async () => {
    expect(await (await fetch(`${base}/app.js`)).text()).toContain("console.log");
    expect((await fetch(`${base}/missing.js`, { headers: html })).status).toBe(404);
    expect((await fetch(`${base}/api/nothing`, { headers: html })).status).toBe(404);
    expect((await fetch(`${base}/shipments/S-1`, { headers: { accept: "application/json" } })).status).toBe(404);
  });
});
