import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, compileApp, findChromium, verifyApp } from "@typesys/compiler";
import { startApplication } from "@typesys/engineer";

/**
 * The Cold Chain reference application (examples/apps/cold-chain), compiled
 * from its app.json over three services TypeSystem did not write: what is
 * committed is exactly what the compiler generates, every acceptance check
 * passes, and in a browser a coordinator's request becomes, after the
 * model's assessment and a pharmacist's sign-off, a closed excursion and
 * quarantined lots in two different systems.
 */
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/apps/cold-chain");
const chrome = findChromium();

describe("the cold chain application", () => {
  it("is exactly what the compiler generates from its app.json", async () => {
    const r = await compileApp(APP);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect({ written: r.written, created: r.created, removed: r.removed }).toEqual({ written: [], created: [], removed: [] });
  });

  // Four of its checks are screen checks, which need a Chromium.
  it.skipIf(!chrome)("passes every acceptance check against a fresh copy of itself and the three services", async () => {
    const r = await verifyApp(APP);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks).toHaveLength(18);
  }, 300_000);
});

describe.skipIf(!chrome)("the cold chain application in a browser", () => {
  let browser: Browser;
  let app: { baseUrl: string; stop: () => void } | undefined;
  beforeAll(async () => {
    expect(await buildApp(APP)).toEqual([]);
    const started = await startApplication(APP);
    if ("diagnostic" in started) throw new Error(started.diagnostic.message);
    app = started;
    browser = await chromium.launch({ executablePath: chrome!, args: ["--no-sandbox"] });
  }, 180_000);
  afterAll(async () => {
    app?.stop();
    await browser?.close();
  });

  const open = async (token: string, route: string): Promise<{ page: Page; problems: string[] }> => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await page.addInitScript((t: string) => sessionStorage.setItem("typesys.token", t), token);
    await page.goto(app!.baseUrl + route);
    return { page, problems };
  };
  const toasts = (page: Page) => page.locator(".ts-toast").allInnerTexts();

  it("the model assesses, the coordinator asks, the pharmacist signs off, and two systems change", async () => {
    // The coordinator: the model's assessment first, which changes nothing.
    const c = await open("demo-logistics-token", "/excursions/EX-301");
    try {
      await c.page.getByRole("button", { name: "Assess this excursion" }).click();
      const answer = c.page.locator('[data-answer="assess"]');
      await answer.waitFor({ timeout: 20_000 });
      expect(await answer.innerText()).toMatch(/quarantine/i);
      await c.page.getByRole("button", { name: "Request disposition" }).click();
      await expect.poll(() => toasts(c.page), { timeout: 20_000 }).toEqual(expect.arrayContaining([expect.stringContaining("Waiting for approval")]));
      expect(c.problems).toEqual([]);
    } finally {
      await c.page.close();
    }

    // The pharmacist: the request in their queue, with what the model said.
    const q = await open("demo-qa-token", "/");
    try {
      const item = q.page.locator("[data-approval]").first();
      await item.waitFor({ timeout: 20_000 });
      expect(await item.innerText()).toMatch(/quarantine/i);
      await item.getByRole("button", { name: "Approve" }).click();
      await expect.poll(() => toasts(q.page), { timeout: 20_000 }).toEqual(expect.arrayContaining([expect.stringContaining("Approved")]));
      // The excursion is closed in the sensor hub: it leaves the open list.
      await expect.poll(() => q.page.locator('[data-node="open-excursions"] [data-row]').count(), { timeout: 20_000 }).toBe(2);
      expect(q.problems).toEqual([]);
    } finally {
      await q.page.close();
    }

    // The inventory: both lots on the shipment are held.
    const l = await open("demo-qa-token", "/lots");
    try {
      const held = l.page.locator('[data-node="lots-table"] [data-row="L-7731"], [data-node="lots-table"] [data-row="L-7732"]');
      await expect.poll(async () => (await held.allInnerTexts()).filter((t) => t.includes("Quarantined")).length, { timeout: 20_000 }).toBe(2);
      expect(l.problems).toEqual([]);
    } finally {
      await l.page.close();
    }
  }, 120_000);

  it("shows a carrier only their own freight, and nobody signed in a refusal", async () => {
    const carrier = await open("demo-carrier-token", "/");
    try {
      const table = carrier.page.locator('[data-node="shipments-table"]');
      await expect.poll(() => table.locator("[data-row]").count(), { timeout: 15_000 }).toBe(3);
      expect(await carrier.page.locator('[data-node="open-excursions"]').getAttribute("data-state")).toBe("error");
    } finally {
      await carrier.page.close();
    }
    const nobody = await open("", "/");
    try {
      await expect.poll(() => nobody.page.locator('[data-node="shipments-table"]').getAttribute("data-state"), { timeout: 15_000 }).toBe("error");
    } finally {
      await nobody.page.close();
    }
  }, 60_000);
});
