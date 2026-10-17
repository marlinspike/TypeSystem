import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { describeModel } from "@typesys/core";
import { recordBaseline } from "@typesys/devkit";
import { buildAirforceProposal, buildAirforceWorkbench, demoAudiences, demoIdentities, groundForRepair, resolveDemoIdentity } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel } from "@typesys/workflow";
import { findChrome } from "../../../scripts/find-chrome.js";
import { appUses } from "../../compiler/src/uses.js";
import { squadronApp } from "../../compiler/test/fixtures.js";
import { STUDIO_CLIENT_DIR, createStudioApp } from "../src/index.js";

/**
 * Change impact in the workbench (ADR-0093): a baseline recorded before the
 * proposed release of readinessStatus, loaded from a file and compared with
 * the deployment running the proposal.
 */
const chrome = findChrome();
const built = existsSync(path.join(STUDIO_CLIENT_DIR, "studio.js"));
const shots = process.env.STUDIO_SCREENSHOTS;
const PEOPLE = [demoIdentities.maintainer, demoIdentities.viewer, demoIdentities.lead];

describe.skipIf(!chrome || !built)("change impact in a browser (ADR-0093)", () => {
  let server: Server;
  let base: string;
  let browser: Browser;
  let page: Page;
  let baselineFile: string;
  const problems: string[] = [];

  beforeAll(async () => {
    const before = await buildAirforceWorkbench({ mockRestLatencyMs: 0 });
    const baseline = await recordBaseline(before.runtime, demoIdentities.lead, { callers: Object.fromEntries(PEOPLE.map((p) => [p.subjectId, p])), explainedBy: "recorder" });
    baselineFile = path.join(mkdtempSync(path.join(tmpdir(), "impact-")), "baseline.json");
    writeFileSync(baselineFile, JSON.stringify(baseline));
    const proposal = await buildAirforceProposal({ mockRestLatencyMs: 0 });
    const workflows = await WorkflowEngine.create({ host: proposal, model: scriptedModel({}, "scripted", demoAudiences.enclaveModel) });
    workflows.register(groundForRepair);
    const app = createStudioApp({
      backend: proposal,
      identityResolver: resolveDemoIdentity,
      workflows,
      consumers: appUses(squadronApp(), await describeModel(proposal.registry)),
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

  it(
    "shows the lead that the proposal exposes readiness to the viewer, and which checks to run",
    async () => {
      await page.goto(`${base}/`);
      await page.getByRole("button", { name: "Lead", exact: true }).click();
      await page.getByTestId("subject").filter({ hasText: demoIdentities.lead.subjectId }).waitFor();
      await page.getByRole("tab", { name: "Impact" }).click();
      await page.getByLabel("Or load one").setInputFiles(baselineFile);
      await page.getByTestId("baseline").filter({ hasText: "with the inspection" }).waitFor();
      await page.getByRole("button", { name: "Compare with the model now" }).click();
      await page.getByTestId("verdict").filter({ hasText: "risky" }).waitFor();
      const rows = page.getByTestId("impact-items").locator("tbody tr");
      // The exposure comes first, then the release that causes it.
      await expect.poll(() => rows.first().innerText()).toContain("observed: widens");
      expect(await rows.first().innerText()).toContain(demoIdentities.viewer.subjectId);
      expect(await rows.nth(1).innerText()).toContain("now released from maintenanceStatus");
      expect(await page.getByTestId("impact-checks").innerText()).toContain("check.");
      if (shots) await page.screenshot({ path: path.join(shots, "workbench-impact.png"), fullPage: true });

      // Recording now and comparing at once finds nothing.
      await page.getByRole("button", { name: "Record a baseline now" }).click();
      await page.getByTestId("baseline").filter({ hasText: "recorded now" }).waitFor();
      await page.getByRole("button", { name: "Compare with the model now" }).click();
      await page.getByTestId("verdict").filter({ hasText: "compatible" }).waitFor();
      expect(problems).toEqual([]);
    },
    60_000
  );
});
