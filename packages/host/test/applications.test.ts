import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coldChainEnvironment, recallDeployment, startService, startServices, type RunningService, type RunningServices } from "@typesys/cold-chain";
import { overlayEnvironment } from "../src/host.js";
import { serve, type Serving } from "../src/serve.js";
import type { Deployment } from "../src/deployment.js";

/**
 * ADR-0108: a compiled application runs inside the generic server, on the
 * deployment's one runtime and one workflow engine, and still passes every
 * hidden acceptance check its challenge was written with (the recall
 * response, docs/evidence/showcase-challenge). Each check gets fresh
 * services and a fresh server, as the challenge scored it. Skipped until the
 * application is built (`typesys app build examples/apps/recall-response`),
 * which `npm run check:full` does.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appsDir = path.join(repo, "examples", "apps");
const built = existsSync(path.join(appsDir, "recall-response", "dist", "server.js"));

interface HiddenCheck {
  readonly id: string;
  run(api: { call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> }): Promise<void>;
}

describe.skipIf(!built)("a compiled application hosted by the generic server (ADR-0108)", () => {
  let dir: string;
  let file: string;
  let checks: HiddenCheck[];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "typesys-hosted-"));
    file = path.join(dir, "recalls.deployment.json");
    const deployment: Deployment = { ...recallDeployment, applications: [{ name: "recall-response", port: "0" }] };
    await writeFile(file, JSON.stringify(deployment, null, 2));
    checks = ((await import(pathToFileURL(path.join(repo, "packages", "evaluation", "hidden", "recall-response.mjs")).href)) as { default: HiddenCheck[] }).default;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function hosted<T>(fn: (s: Serving) => Promise<T>): Promise<T> {
    let services: RunningServices | undefined;
    let exchange: RunningService | undefined;
    let serving: Serving | undefined;
    try {
      [services, exchange] = await Promise.all([startServices(), startService("recall-exchange")]);
      const env = overlayEnvironment(
        { TYPESYS_COLDCHAIN_RECALLS_URL: exchange.url },
        coldChainEnvironment({ tracker: services.tracker.url, sensors: services.sensors.url, inventory: services.inventory.url })
      );
      serving = await serve({ file, port: 0, hostEnv: env, appsDir, packsDir: path.join(repo, "packs") });
      return await fn(serving);
    } finally {
      await serving?.close();
      await Promise.allSettled([services?.stop(), exchange?.stop()]);
    }
  }

  const api = (port: number) => ({
    async call(token: string, method: string, p: string, body?: unknown) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const text = await res.text();
      return { status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
    }
  });

  it("serves the application's API and pages beside the deployment's, on one runtime", async () => {
    await hosted(async (s) => {
      const port = s.applications["recall-response"]!;
      expect(port).toBeGreaterThan(0);
      const version = (await (await fetch(`http://127.0.0.1:${s.port}/version`)).json()) as { applications: string[] };
      expect(version.applications).toEqual(["recall-response"]);
      const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
      expect(await page.text()).toContain("Recall Response");
      // One engine: a run the application starts is the deployment's run, read back through the deployment's own API.
      const started = await api(port).call("demo-qa-token", "POST", "/api/workflows/coldchain.RespondToRecall/runs", { input: { recallId: "RCL-26-0412" } });
      expect(started.status).toBe(201);
      const runId = (started.body as { runId: string }).runId;
      const read = await api(s.port).call("demo-qa-token", "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expect(read.status).toBe(200);
      // One audit trail: the start was audited by the deployment's runtime, on its one chain.
      const rows = await s.host.state.audit.readChain(s.host.state.audit.chain);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it("passes all 16 hidden acceptance checks", { timeout: 240_000 }, async () => {
    const failed: string[] = [];
    for (const check of checks) {
      await hosted(async (s) => {
        try {
          await check.run(api(s.applications["recall-response"]!));
        } catch (err) {
          failed.push(`${check.id}: ${(err as Error).message}`);
        }
      });
    }
    expect(checks).toHaveLength(16);
    expect(failed).toEqual([]);
  });
});
