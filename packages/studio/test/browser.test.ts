import { existsSync, mkdirSync, readdirSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { STUDIO_CLIENT_DIR, createStudioApp } from "../src/index.js";

/**
 * A real browser through the built client. It needs a Chromium: `CHROME_PATH`,
 * Playwright's (`/opt/pw-browsers`), or the system's (GitHub's runners have
 * Chrome). Without one, or before `npm run build` bundles the client, it skips.
 */
function findChrome(): string | undefined {
  const pw = "/opt/pw-browsers";
  const candidates = [
    process.env.CHROME_PATH,
    ...(existsSync(pw) ? readdirSync(pw).filter((d) => d.startsWith("chromium-")).map((d) => path.join(pw, d, "chrome-linux/chrome")) : []),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return candidates.find((c): c is string => typeof c === "string" && existsSync(c));
}

const chrome = findChrome();
const built = existsSync(path.join(STUDIO_CLIENT_DIR, "studio.js"));
/** Set to a directory to keep a screenshot of each screen (the docs' images). */
const shots = process.env.STUDIO_SCREENSHOTS;

describe.skipIf(!chrome || !built)("the Studio in a browser (ADR-0061)", () => {
  let server: Server;
  let base: string;
  let browser: Browser;
  let page: Page;
  const problems: string[] = [];

  beforeAll(async () => {
    const testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const app = createStudioApp({
      backend: testbed,
      identityResolver: resolveDemoIdentity,
      demoTokens: { Maintainer: "demo-maintainer-token", Viewer: "demo-viewer-token" }
    });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome!, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    // A script error, or anything the page's Content Security Policy blocked, fails the run.
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
  const runQuery = async (query: unknown) => {
    await page.getByRole("tab", { name: "Query" }).click();
    await page.getByLabel("Query", { exact: true }).fill(JSON.stringify(query, null, 2));
    await page.getByRole("button", { name: "Run" }).click();
    await page.getByTestId("results").waitFor();
    const rows = await page.getByTestId("results").locator("tbody tr").all();
    return Promise.all(rows.map((r) => r.locator("td").allTextContents()));
  };

  it(
    "shows each caller exactly what the runtime decides for them, and fixes, explains and codes a query",
    async () => {
      await page.goto(`${base}/`);
      await page.getByTestId("subject").filter({ hasText: "anonymous" }).waitFor();
      await page.getByTestId("types").getByRole("button", { name: "airforce.Aircraft" }).click();
      await page.getByTestId("type").getByText("needsAttention").waitFor();
      await shot("model");

      // A query with a misspelt value: the API's diagnostic, its suggestion applied with one click.
      await signInAs("Viewer", "user-viewer-1");
      await page.getByRole("tab", { name: "Query" }).click();
      const editor = page.getByLabel("Query", { exact: true });
      await editor.fill(JSON.stringify({ type: "airforce.Aircraft", select: ["tailNumbr"], limit: 5 }));
      const fix = page.getByRole("button", { name: "Use “tailNumber”" });
      await fix.waitFor();
      expect(await page.getByRole("button", { name: "Run" }).isDisabled()).toBe(true);
      await fix.click();
      expect(JSON.parse(await editor.inputValue())).toEqual({ type: "airforce.Aircraft", select: ["tailNumber"], limit: 5 });
      await expect.poll(() => page.getByTestId("diagnostics").locator("li").count()).toBe(0);
      expect(await page.getByTestId("sdk-code").textContent()).toBe('client.from("airforce.Aircraft")\n  .select("tailNumber")\n  .limit(5)');

      // The same query as two people: the viewer never gets the SECRET value; the maintainer does.
      const query = { type: "airforce.Aircraft", select: ["tailNumber", "deploymentLocation"], limit: 20 };
      const asViewer = await runQuery(query);
      expect(asViewer.length).toBeGreaterThan(0);
      expect(asViewer.every((cells) => cells[1] !== "" && cells[2] === "")).toBe(true);
      await shot("query-viewer");
      await signInAs("Maintainer", "user-maintainer-1");
      const asMaintainer = await runQuery(query);
      expect(asMaintainer.some((cells) => cells[2] !== "")).toBe(true);

      await page.getByRole("button", { name: "Explain" }).click();
      await expect.poll(() => page.getByTestId("plan").locator("li").count()).toBeGreaterThan(1);
      await shot("query-maintainer");

      expect(problems).toEqual([]);
    },
    60_000
  );

  it(
    "previews an Action before it can be invoked, and invokes only what was previewed, once confirmed",
    async () => {
      await signInAs("Viewer", "user-viewer-1");
      await page.getByRole("tab", { name: "Actions" }).click();
      await page.getByTestId("actions").getByRole("button", { name: "CreateMaintenanceWorkOrder" }).click();
      await page.getByLabel("Maintenance event id").fill("EVT-9001");
      await page.getByLabel("Assigned to").fill("SSgt Rivera");
      await page.getByRole("button", { name: "Preview" }).click();
      const preview = page.getByTestId("preview");
      await preview.getByText("Would be refused").waitFor();
      expect(await preview.locator(".blockers").textContent()).toMatch(/authorization/);
      expect(await page.getByRole("button", { name: "Invoke…" }).count()).toBe(0);

      await signInAs("Maintainer", "user-maintainer-1");
      await page.getByRole("tab", { name: "Actions" }).click();
      await page.getByTestId("actions").getByRole("button", { name: "CreateMaintenanceWorkOrder" }).click();
      await page.getByLabel("Maintenance event id").fill("EVT-9001");
      await page.getByLabel("Assigned to").fill("SSgt Rivera");
      await page.getByRole("button", { name: "Preview" }).click();
      await preview.getByText("Would run").waitFor();

      // Changing the input after the preview withdraws the invocation until it is previewed again.
      await page.getByLabel("Assigned to").fill("MSgt Okafor");
      await preview.getByText("The form has changed").waitFor();
      expect(await page.getByRole("button", { name: "Invoke…" }).count()).toBe(0);
      await page.getByRole("button", { name: "Preview" }).click();
      await page.getByRole("button", { name: "Invoke…" }).click();
      await shot("action-confirm");
      await page.getByRole("button", { name: "Confirm and invoke" }).click();
      const outcome = page.getByTestId("outcome");
      await outcome.waitFor();
      expect(JSON.parse((await outcome.locator("pre").textContent()) ?? "null")).toMatchObject({ maintenanceEventId: "EVT-9001", assignedTo: "MSgt Okafor" });

      expect(problems).toEqual([]);
    },
    60_000
  );
});
