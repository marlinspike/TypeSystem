import { describe, it, expect } from "vitest";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { airforceDeployment } from "@typesys/demo-web/deployments";
import { validateDeployment } from "../src/deployment.js";
import { serve } from "../src/serve.js";
import { routeOf, type RequestLogLine } from "../src/telemetry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packsDir = path.join(root, "packs");

describe("request logs (ADR-0121)", () => {
  it("keep the model and drop every value: object and run ids, long segments, the query", () => {
    expect(routeOf("/api/objects/airforce.Aircraft/AF86-0147")).toBe("/api/objects/airforce.Aircraft/:id");
    expect(routeOf("/api/objects/airforce.Aircraft/AF86-0147/related/components?limit=5")).toBe("/api/objects/airforce.Aircraft/:id/related/components");
    expect(routeOf("/api/objects/shop.Customer/ada%40example.com/provenance/email")).toBe("/api/objects/shop.Customer/:id/provenance/email");
    expect(routeOf("/api/workflow-runs/01JXYZ/approval")).toBe("/api/workflow-runs/:id/approval");
    expect(routeOf(`/api/${"x".repeat(80)}`)).toBe("/api/:value");
    expect(routeOf("/mcp")).toBe("/mcp");
  });

  it("write one JSON line per request with its id, status and time, and nothing a caller sent", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "typesys-log-"));
    const file = path.join(dir, "airforce.deployment.json");
    writeFileSync(file, JSON.stringify(airforceDeployment));
    const lines: string[] = [];
    const s = await serve({ file, port: 0, packsDir, logLine: (l) => lines.push(l) });
    try {
      const base = `http://localhost:${s.port}`;
      const res = await fetch(`${base}/api/objects/airforce.Aircraft/AF86-0147?select=tailNumber`, { headers: { authorization: "Bearer demo-viewer-token", "x-request-id": "req-42" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toBe("req-42");
      const bad = await fetch(`${base}/api/objects/airforce.Aircraft/NOPE`, { headers: { authorization: "Bearer demo-viewer-token", "x-request-id": "not/a token" } });
      expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      await fetch(`${base}/healthz`);
      await new Promise((r) => setTimeout(r, 50));
      const parsed = lines.map((l) => JSON.parse(l) as RequestLogLine);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ level: "info", event: "http", deployment: "airforce", build: s.host.build, requestId: "req-42", method: "GET", route: "/api/objects/airforce.Aircraft/:id", status: 200 });
      expect(parsed[0]!.ms).toBeGreaterThanOrEqual(0);
      expect(parsed[1]).toMatchObject({ level: "warn", status: 404 });
      const all = lines.join("\n");
      for (const leaked of ["AF86-0147", "NOPE", "demo-viewer-token", "tailNumber", "F-16C"]) expect(all).not.toContain(leaked);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("telemetry declared in the deployment (ADR-0121)", () => {
  it("is validated", () => {
    const problems = (telemetry: unknown) => validateDeployment({ ...airforceDeployment, runtime: { telemetry } }).join("\n");
    expect(problems({ otlpEndpoint: "otel:4318" })).toContain("runtime.telemetry.otlpEndpoint: must be an http(s) URL");
    expect(problems({ otlpEndpoint: { $env: "OTEL_URL" }, metricsIntervalSeconds: 0 })).toContain("metricsIntervalSeconds: must be a whole number of seconds");
    expect(problems({ otlpEndpoint: "http://otel:4318", bogus: 1 })).toContain('runtime.telemetry: unknown field "bogus"');
    expect(problems({ otlpEndpoint: "http://otel:4318", serviceName: "fleet" })).toBe("");
    expect(validateDeployment({ ...airforceDeployment, runtime: { requestLog: "no" } }).join("\n")).toContain("runtime.requestLog: must be true or false");
  });

  it("sends the runtime's spans to an OTLP collector, named for the deployment and its build, with no value in them", async () => {
    const received: { path: string; body: string }[] = [];
    const collector = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        received.push({ path: req.url ?? "", body });
        res.setHeader("content-type", "application/json");
        res.end("{}");
      });
    });
    await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
    const endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
    const dir = mkdtempSync(path.join(tmpdir(), "typesys-otel-"));
    const file = path.join(dir, "airforce.deployment.json");
    writeFileSync(file, JSON.stringify({ ...airforceDeployment, runtime: { ...airforceDeployment.runtime, telemetry: { otlpEndpoint: endpoint, serviceName: "fleet-runtime" }, requestLog: false } }));
    const s = await serve({ file, port: 0, packsDir });
    const build = s.host.build;
    try {
      const res = await fetch(`http://localhost:${s.port}/api/objects/airforce.Aircraft/AF86-0147`, { headers: { authorization: "Bearer demo-maintainer-token" } });
      expect(res.status).toBe(200);
    } finally {
      // Closing flushes what is buffered.
      await s.close();
      await new Promise<void>((r) => collector.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
    const traces = received.filter((r) => r.path === "/v1/traces");
    expect(traces.length).toBeGreaterThan(0);
    const body = traces.map((t) => t.body).join("\n");
    expect(body).toContain("fleet-runtime");
    expect(body).toContain(build);
    expect(body).toContain("SemanticRuntime.getObject");
    for (const leaked of ["AF86-0147", "demo-maintainer", "F-16C", "FOB ALPHA", "degraded"]) expect(body).not.toContain(leaked);
    // The runtime's metrics too, though its instruments were made before the deployment registered a provider.
    const metricBody = received.filter((r) => r.path === "/v1/metrics").map((t) => t.body).join("\n");
    expect(metricBody).toContain("typesys.operation.duration");
    expect(metricBody).toContain("typesys.policy.decisions");
    for (const leaked of ["AF86-0147", "demo-maintainer", "F-16C"]) expect(metricBody).not.toContain(leaked);
  });
});
