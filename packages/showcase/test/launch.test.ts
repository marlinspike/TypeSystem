import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChromium } from "@typesys/compiler";
import { ROOT, SURFACES, Stack, preflight, startGuide } from "../src/index.js";

/**
 * The whole showcase, started as `npm run showcase` starts it, and driven in
 * Chromium: local only, beside `npm run check:full`, never on a pull
 * request's CI (it starts eleven servers). Needs the build, the two
 * applications built, and the showcase's ports free. With
 * TYPESYS_SHOWCASE_SCREENSHOTS set it saves the README's screenshots.
 */
const chrome = findChromium();
const shots = process.env.TYPESYS_SHOWCASE_SCREENSHOTS ? path.join(ROOT, "docs/images/showcase") : undefined;
const url = (key: keyof typeof SURFACES, p = "/") => `http://127.0.0.1:${SURFACES[key].port}${p}`;

describe.skipIf(!chrome || process.env.CI !== undefined)("the showcase, launched", () => {
  let stack: Stack;
  let guide: Server;
  let browser: Browser;
  let page: Page;
  const shoot = async (name: string) => {
    if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
  };

  beforeAll(async () => {
    const pre = await preflight();
    if (!pre.ok) throw new Error(`The showcase cannot start: ${pre.problems.join("; ")}. ${pre.fixes.join("; ")}`);
    if (shots) mkdirSync(shots, { recursive: true });
    stack = new Stack();
    await stack.start();
    guide = (await startGuide(stack)).server;
    browser = await chromium.launch({ executablePath: chrome! });
    page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => guide?.close(r));
    await stack?.stop();
  });

  it("starts every surface and service, and the guide asks the ten questions", async () => {
    await page.goto(url("guide"));
    await expect.poll(() => page.locator(".dot.up").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(9);
    expect(await page.locator(".dot.down").count()).toBe(0);
    expect(await page.locator("section.q").count()).toBe(10);
    await shoot("guide");
  });

  it("reads one notice as each caller: the embargo is need-to-know for quality assurance", async () => {
    await page.locator("#cmp-read").selectOption("embargoed");
    await page.locator("#cmp-go").click();
    const rows = page.locator("#cmp-out tbody tr");
    await expect.poll(() => rows.count()).toBe(6);
    const text = await page.locator("#cmp-out").innerText();
    expect(text).toMatch(/logistics[\s\S]*403[\s\S]*need-to-know for quality assurance/);
    expect(text).toMatch(/qa\b[\s\S]*200[\s\S]*healthHazard/);
    await page.locator("#live-compare").scrollIntoViewIfNeeded();
    await shoot("guide-compare");
  });

  it("reports the lots unavailable while the pharmacy inventory is down, and recovers", { timeout: 90_000 }, async () => {
    await page.locator("#inv-down").click();
    await expect.poll(() => page.locator("#probe-table").innerText(), { timeout: 15_000 }).toMatch(/lots it carries[\s\S]*503[\s\S]*could not be reached/);
    expect(await page.locator("#probe-table").innerText()).toMatch(/readings[\s\S]*200/);
    await page.locator("#live-outage").scrollIntoViewIfNeeded();
    await shoot("guide-outage");
    // The application says so too, on the shipment's own page.
    const app = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await app.goto(url("coldChain", "/shipments/SH-1042?as=logistics"));
    await expect.poll(() => app.locator("body").innerText(), { timeout: 20_000 }).toMatch(/SH-1042/);
    await expect.poll(() => app.locator("body").innerText(), { timeout: 20_000 }).toMatch(/Lots on board\s+The service could not answer/);
    if (shots) await app.screenshot({ path: path.join(shots, "cold-chain-outage.png") });
    await app.close();
    await page.locator("#inv-up").click();
    await expect.poll(() => page.locator("#probe-table").innerText(), { timeout: 15_000 }).toMatch(/lots it carries[\s\S]*200/);
  });

  it("walks the recall response: refused self-approval, refused direct hold, QA sign-off, lots quarantined", async () => {
    await page.locator("#wf-go").click();
    await expect.poll(() => page.locator("#wf-out tbody tr").count(), { timeout: 30_000 }).toBe(8);
    const text = await page.locator("#wf-out").innerText();
    expect(text).toMatch(/initiator of a run may not approve it/);
    expect(text).toMatch(/Requires an approval/);
    expect(text).toMatch(/run completed/);
    expect(text).toMatch(/quarantined: Recall RCL-26-0412/);
    expect(text).toMatch(/signed off by Dr\. Priya Raman/);
    await page.locator("#live-workflow").scrollIntoViewIfNeeded();
    await shoot("guide-workflow");
  });

  it("opens the recall application signed in from a link", async () => {
    await page.goto(url("recall", "/?as=qa"));
    await expect.poll(() => page.locator("body").innerText(), { timeout: 20_000 }).toContain("RCL-26-0388");
    expect(page.url()).not.toContain("as=qa");
    await shoot("recall-app");
  }, 60_000);

  it("opens Studio over four systems", async () => {
    await page.goto(url("studioColdChain", "/#tab=model&as=QA"));
    await expect.poll(() => page.locator("body").innerText(), { timeout: 20_000 }).toContain("coldchain.Recall");
    await page.goto("about:blank");
    await page.goto(url("studioColdChain", "/#tab=graph&as=QA"));
    await page.waitForTimeout(2_000);
    await shoot("studio-cold-chain");
  }, 60_000);
});
