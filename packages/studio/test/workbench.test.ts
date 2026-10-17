import { existsSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { describeModel, requireRole } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, resolveDemoIdentity } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel } from "@typesys/workflow";
import { findChrome } from "../../../scripts/find-chrome.js";
import { appUses } from "../../compiler/src/uses.js";
import { squadronApp } from "../../compiler/test/fixtures.js";
import { STUDIO_CLIENT_DIR, createStudioApp } from "../src/index.js";

/**
 * The semantic workbench in a real browser (ADR-0091): the dependency graph,
 * the inspector, dependents, and explanations, as an inspector and as a
 * caller who may not inspect. Without a Chromium, or before `npm run build`
 * bundles the client, it skips.
 */
const chrome = findChrome();
const built = existsSync(path.join(STUDIO_CLIENT_DIR, "studio.js"));
const shots = process.env.STUDIO_SCREENSHOTS;
const PEOPLE = [demoIdentities.maintainer, demoIdentities.viewer, demoIdentities.lead];

describe.skipIf(!chrome || !built)("the semantic workbench in a browser (ADR-0091)", () => {
  let server: Server;
  let base: string;
  let browser: Browser;
  let page: Page;
  const problems: string[] = [];

  beforeAll(async () => {
    const testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { inspection: { policy: "typesys.inspect" } } });
    (testbed.policyEngine as unknown as { registerRule(n: string, r: unknown): void }).registerRule("typesys.inspect", requireRole("lead"));
    const workflows = await WorkflowEngine.create({ host: testbed, model: scriptedModel({}, "scripted", demoAudiences.enclaveModel) });
    workflows.register(groundForRepair);
    const app = createStudioApp({
      backend: testbed,
      identityResolver: resolveDemoIdentity,
      workflows,
      consumers: appUses(squadronApp(), await describeModel(testbed.registry)),
      subjects: { list: async () => PEOPLE.map((p) => ({ subjectId: p.subjectId })), resolve: async (id) => PEOPLE.find((p) => p.subjectId === id) },
      demoTokens: { Lead: "demo-lead-token", Viewer: "demo-viewer-token" }
    });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome!, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(e.message));
    if (shots) mkdirSync(shots, { recursive: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
  };
  const signInAs = async (label: string, subject: string) => {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByTestId("subject").filter({ hasText: subject }).waitFor();
  };
  const findNode = async (text: string, kind: string) => {
    await page.getByLabel("Find a node").fill(text);
    await page.getByTestId("graph-matches").getByRole("button").filter({ hasText: kind }).filter({ hasText: text }).first().click();
  };

  it(
    "shows an inspector what guards a value, what depends on it, and why another caller sees what they see",
    async () => {
      await page.goto(`${base}/`);
      await signInAs("Lead", demoIdentities.lead.subjectId);
      await page.getByRole("tab", { name: "Graph" }).click();
      await page.getByTestId("graph-structure").filter({ hasText: "Built from an inspection" }).waitFor();
      // Cytoscape draws on canvases inside the container.
      await page.getByTestId("graph-canvas").locator("canvas").first().waitFor();
      await page.waitForTimeout(300);
      await shot("workbench-overview");

      await findNode("maintenanceStatus", "member");
      const inspector = page.getByTestId("inspector");
      await inspector.getByTestId("guards").getByText("airforce.maintainer-only").waitFor();
      expect(await inspector.getByTestId("guards").textContent()).toContain("role in [maintainer, ai-enclave]");
      await inspector.getByRole("button", { name: "What depends on it" }).click();
      const reach = inspector.getByTestId("reach");
      await reach.waitFor();
      const reached = (await reach.textContent()) ?? "";
      for (const expected of ["readinessStatus", "needsAttention", "Board", "viewer-lacks-status", "app:squadron-maintenance", "workflow:airforce.GroundForRepair"]) expect(reached).toContain(expected);
      await page.waitForTimeout(300);
      await shot("workbench-dependents");

      await inspector.getByRole("button", { name: "Explain access" }).click();
      await page.getByLabel("Object id").fill("AF86-0147");
      await page.getByLabel("For").selectOption(demoIdentities.viewer.subjectId);
      await page.getByRole("button", { name: "Explain", exact: true }).click();
      const explanation = page.getByTestId("explanation");
      await explanation.getByTestId("findings").waitFor();
      expect(await explanation.getByTestId("outcome").textContent()).toBe("partial");
      const text = (await explanation.textContent()) ?? "";
      expect(text).toContain("airforce.maintainer-only");
      expect(text).toContain("SECRET");
      expect(text).toContain("derivation");
      await shot("workbench-explain");
      expect(problems).toEqual([]);
    },
    60_000
  );

  it(
    "shows a caller who may not inspect the graph without its governance, and only their own access, without policy names",
    async () => {
      await signInAs("Viewer", demoIdentities.viewer.subjectId);
      await page.getByRole("tab", { name: "Graph" }).click();
      await page.getByTestId("graph-structure").filter({ hasText: "you may not inspect" }).waitFor();
      await page.getByRole("tab", { name: "Explain" }).click();
      await page.getByText("Explaining someone else's access needs the inspection policy").waitFor();
      await page.getByLabel("Object id").fill("AF86-0147");
      await page.getByRole("button", { name: "Explain", exact: true }).click();
      const explanation = page.getByTestId("explanation");
      await explanation.getByTestId("findings").waitFor();
      const text = (await explanation.textContent()) ?? "";
      expect(text).toContain("only what a refusal tells the caller");
      expect(text).not.toContain("airforce.maintainer-only");
      expect(text).not.toContain("degraded");
      expect(problems).toEqual([]);
    },
    60_000
  );
});
