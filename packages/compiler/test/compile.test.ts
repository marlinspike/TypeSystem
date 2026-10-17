import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApplication } from "@typesys/engineer";
import { buildApp, checkAppDir, compileApp, findChromium, generate, readLock, verifyApp, type AppSpec } from "../src/index.js";
import { squadronDir } from "./apps.js";
import { squadronApp } from "./fixtures.js";

/**
 * The compiler end to end (ADR-0082, ADR-0083, ADR-0084): a checked
 * application becomes ordinary TypeScript and React that tsc accepts, that
 * the existing runtime and workflow engine run, and that passes its own
 * acceptance checks, API and screen alike.
 */
const chrome = findChromium();
const withRisk = () => {
  const app = squadronApp();
  const grid = (app.pages[0]!.layout as unknown as { children: unknown[] }).children;
  grid.splice(1, 0, { kind: "metric", id: "risk", label: "Risk", span: 3, value: { fn: "risk#score", args: { attention: { count: "$attention" } }, returns: { type: "number" } } });
  return app;
};

describe("compileApp", () => {
  it("writes the application once, then nothing while nothing changed", async () => {
    const dir = await squadronDir("deterministic");
    const first = await compileApp(dir);
    expect(first.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(first.written).toEqual(expect.arrayContaining(["server.ts", "src/generated/flows/ground.ts", "src/generated/pages/Board.tsx", "src/generated/app.tsx"]));
    expect(first.created).toEqual(expect.arrayContaining(["package.json", "tsconfig.json"]));
    const again = await compileApp(dir);
    expect(again.ok).toBe(true);
    expect(again.written).toEqual([]);
    expect(again.created).toEqual([]);
    // Generation is a pure function of the checked application.
    const a = generate(first.analysis!);
    const b = generate(again.analysis!);
    expect([...a.owned]).toEqual([...b.owned]);
    const lock = await readLock(dir);
    expect(Object.keys(lock!.files).sort()).toEqual([...a.owned.keys()].sort());
  });

  it("writes nothing for an application the checker refuses", async () => {
    const app = squadronApp();
    (app.pages[0]!.layout as unknown as { children: { kind: string; data?: string }[] }).children[1]!.data = "attentoin";
    const dir = await squadronDir("refused", app);
    const r = await compileApp(dir);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === "unknown-reference")).toMatchObject({ at: "/pages/0/layout/children/1/data" });
    expect(existsSync(path.join(dir, "server.ts"))).toBe(false);
  });

  it("stops at a generated file edited by hand, naming it, and overwrites it only when told to", async () => {
    const dir = await squadronDir("edited");
    await compileApp(dir);
    const board = path.join(dir, "src/generated/pages/Board.tsx");
    await writeFile(board, `${await readFile(board, "utf8")}\n// a local change\n`);
    const r = await compileApp(dir);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toEqual([expect.objectContaining({ code: "edited-generated-file", at: "src/generated/pages/Board.tsx" })]);
    const forced = await compileApp(dir, { force: true });
    expect(forced.ok).toBe(true);
    expect(forced.written).toEqual(["src/generated/pages/Board.tsx"]);
  });

  it("removes what a removed page generated, and only that", async () => {
    const app = squadronApp() as unknown as { pages: unknown[] };
    app.pages = [...app.pages, { name: "Fleet", title: "Fleet", path: "/fleet", layout: { kind: "metric", id: "fleet-count", label: "Needing attention", value: { count: "$attention" } } }];
    const dir = await squadronDir("removed", app);
    expect((await compileApp(dir)).written).toContain("src/generated/pages/Fleet.tsx");
    await writeFile(path.join(dir, "app.json"), JSON.stringify(squadronApp()));
    const r = await compileApp(dir);
    expect(r.removed).toEqual(["src/generated/pages/Fleet.tsx"]);
    expect(r.written).toEqual(["src/generated/app.tsx"]);
    expect(existsSync(path.join(dir, "src/generated/pages/Fleet.tsx"))).toBe(false);
  });

  it("writes a typed stub for a handwritten function once, and holds the function to its contract", async () => {
    const dir = await squadronDir("extension", withRisk());
    const first = await compileApp(dir);
    expect(first.created).toContain("src/extensions/risk.ts");
    expect(await readFile(path.join(dir, "src/generated/contracts.ts"), "utf8")).toContain("export type RiskScore = (args: RiskScoreArgs) => number | undefined;");
    // The developer's version: never written over.
    const mine = `import type { RiskScore } from "../generated/contracts.js";\n\nexport const score: RiskScore = ({ attention }) => (attention === undefined ? undefined : attention * 10);\n`;
    await writeFile(path.join(dir, "src/extensions/risk.ts"), mine);
    expect((await compileApp(dir)).created).toEqual([]);
    expect(await readFile(path.join(dir, "src/extensions/risk.ts"), "utf8")).toBe(mine);
    expect(await buildApp(dir)).toEqual([]);
    // A function that drifts from its contract is a compile error at the contract check.
    await writeFile(path.join(dir, "src/extensions/risk.ts"), `export const score = (args: { attention: string }) => args.attention.length;\n`);
    const drifted = await buildApp(dir);
    expect(drifted.length).toBeGreaterThan(0);
    expect(drifted[0]).toMatchObject({ code: "compile-error" });
    expect(drifted.some((d) => d.at.startsWith("src/generated/contracts-check.ts"))).toBe(true);
  }, 120_000);

  it("asks the host who each policy admits, as the engine will", async () => {
    const dir = await squadronDir("admitted");
    const { analysis } = await checkAppDir(dir);
    expect(analysis!.flows.ground!.admitted).toEqual({ start: ["maintainer", "lead"], approvals: { leadApproval: ["lead"] } });
  });
});

describe("verifyApp", () => {
  it("builds the application and passes every acceptance check against a fresh copy", async () => {
    const spec = squadronApp() as AppSpec;
    const dir = await squadronDir("verified", chrome ? spec : { ...spec, acceptance: spec.acceptance.filter((c) => c.kind !== "screen") });
    const r = await verifyApp(dir);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual((chrome ? spec.acceptance : spec.acceptance.filter((c) => c.kind !== "screen")).map((c) => c.id));
  }, 180_000);

  it("fails a screen check that the screen does not meet", async () => {
    if (!chrome) return;
    const spec = squadronApp() as AppSpec;
    const dir = await squadronDir("screen-fails", { ...spec, acceptance: [{ id: "viewer-sees-a-table-they-cannot", kind: "screen", as: "anonymous", page: "Board", rows: { "attention-table": { atLeast: 1 } } }] });
    const r = await verifyApp(dir);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === "check-failed")!.message).toContain("attention-table shows 0 rows");
  }, 120_000);
});

describe.skipIf(!chrome)("the compiled application in a browser", () => {
  let browser: Browser;
  let app: { baseUrl: string; stop: () => void } | undefined;
  beforeAll(async () => {
    const dir = await squadronDir("browser");
    expect((await compileApp(dir)).ok).toBe(true);
    expect(await buildApp(dir)).toEqual([]);
    const started = await startApplication(dir);
    if ("diagnostic" in started) throw new Error(started.diagnostic.message);
    app = started;
    browser = await chromium.launch({ executablePath: chrome!, args: ["--no-sandbox"] });
  }, 180_000);
  afterAll(async () => {
    app?.stop();
    await browser?.close();
  });

  const open = async (token: string) => {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await page.addInitScript((t: string) => t && sessionStorage.setItem("typesys.token", t), token);
    await page.goto(app!.baseUrl);
    return { page, problems };
  };

  it("a maintainer grounds an aircraft from the table, and the lead approves it from their queue", async () => {
    const m = await open("demo-maintainer-token");
    try {
      const table = m.page.locator('[data-node="attention-table"]');
      await expect.poll(() => table.locator("[data-row]").count(), { timeout: 10_000 }).toBeGreaterThan(0);
      await table.getByRole("button", { name: "Ground" }).first().click();
      await expect.poll(() => m.page.locator(".ts-toast").allInnerTexts(), { timeout: 15_000 }).toEqual(expect.arrayContaining([expect.stringContaining("Waiting for approval")]));
      // The maintainer started it, so their own queue never shows it.
      expect(await m.page.locator("[data-approval]").count()).toBe(0);
      expect(m.problems).toEqual([]);
    } finally {
      await m.page.close();
    }
    const lead = await open("demo-lead-token");
    try {
      const item = lead.page.locator("[data-approval]").first();
      await item.waitFor({ timeout: 15_000 });
      expect(await item.innerText()).toContain("Lead approval");
      await item.getByRole("button", { name: "Approve" }).click();
      await expect.poll(() => lead.page.locator(".ts-toast").allInnerTexts(), { timeout: 15_000 }).toEqual(expect.arrayContaining([expect.stringContaining("Approved")]));
      await expect.poll(() => lead.page.locator("[data-approval]").count(), { timeout: 10_000 }).toBe(0);
      expect(lead.problems).toEqual([]);
    } finally {
      await lead.page.close();
    }
  }, 90_000);

  it("shows someone not signed in a refusal, never an empty table", async () => {
    const a = await open("");
    try {
      const table = a.page.locator('[data-node="attention-table"]');
      await expect.poll(() => table.getAttribute("data-state"), { timeout: 10_000 }).toBe("error");
      expect(await table.getByRole("alert").innerText()).toMatch(/Sign in|not permitted/);
      expect(await a.page.locator('[data-node="attention-count"]').innerText()).toContain("Unavailable");
    } finally {
      await a.page.close();
    }
  }, 60_000);
});
