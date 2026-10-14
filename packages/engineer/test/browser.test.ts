import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChrome } from "../../../scripts/find-chrome.js";
import { loadHost, scaffoldMission, startApplication, verifyMission, type MissionSpec } from "../src/index.js";

/**
 * The generated views in a real browser (ADR-0071): the application the
 * loop scaffolds and verifies shows each caller what the runtime lets them
 * read, and nothing to someone not signed in. Skips without a Chromium.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const WORK = path.join(pkg, ".work", "browser-test");
const doc = JSON.parse(readFileSync(path.resolve(pkg, "../../examples/missions/component-replacement/mission.json"), "utf8")) as MissionSpec;
const chrome = findChrome();

describe.skipIf(!chrome)("the generated application in a browser (ADR-0071)", () => {
  let browser: Browser;
  let app: { baseUrl: string; stop: () => void } | undefined;
  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    await scaffoldMission(doc, (await loadHost(doc, pkg)).host, WORK);
    expect((await verifyMission(WORK)).ok).toBe(true);
    const started = await startApplication(WORK);
    if ("diagnostic" in started) throw new Error(started.diagnostic.message);
    app = started;
    browser = await chromium.launch({ executablePath: chrome!, args: ["--no-sandbox"] });
  }, 180_000);
  afterAll(async () => {
    app?.stop();
    await browser?.close();
  });

  it("a viewer sees the fleet's components; someone not signed in is refused and sees none", async () => {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/status of 40[13]/.test(m.text()) && problems.push(m.text()));
    try {
      await page.goto(app!.baseUrl);
      const components = page.locator('[data-view="ComponentList"]');
      await expect.poll(() => components.getByRole("alert").count()).toBe(1);
      expect(await components.locator("tbody tr").count()).toBe(0);

      await page.getByLabel("Token").fill("demo-viewer-token");
      await expect.poll(() => components.locator("tbody tr").count(), { timeout: 10_000 }).toBeGreaterThan(2);
      expect(await components.locator("tbody").innerText()).toContain("AVI-200");
      expect(await components.getByRole("alert").count()).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
