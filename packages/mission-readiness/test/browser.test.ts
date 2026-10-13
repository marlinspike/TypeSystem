import { existsSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import type { Express } from "express";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { findChrome } from "../../../scripts/find-chrome.js";
import { MISSION_CLIENT_DIR, buildMissionBackend, createComposedApp, createHandwrittenApp, type MissionBackend } from "../src/index.js";
import { EXPECTED, runScenario } from "./scenario.js";

/**
 * Both versions of the squadron readiness application through a real
 * browser, against one scenario (ADR-0063). Without a Chromium (see
 * scripts/find-chrome.ts), or before `npm run build` bundles the clients, it skips.
 */
const chrome = findChrome();
const built = (["composed", "handwritten"] as const).every((app) => existsSync(path.join(MISSION_CLIENT_DIR, app, "mission.js")));

const APPS: readonly [string, (backend: MissionBackend, dir: string) => Express][] = [
  ["composed", createComposedApp],
  ["handwritten", createHandwrittenApp]
];

describe.skipIf(!chrome || !built)("the squadron readiness application in a browser (ADR-0063)", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chrome!, args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => browser?.close());

  it.each(APPS)("the %s version shows and does what the policy allows each person", async (app, create) => {
    const backend = await buildMissionBackend();
    const server = await new Promise<Server>((resolve) => {
      const s = create(backend, path.join(MISSION_CLIENT_DIR, app)).listen(0, "127.0.0.1", () => resolve(s));
    });
    const page = await browser.newPage();
    // A script error, or anything the page's Content Security Policy blocked, fails the run;
    // refusals the scenario provokes are expected, and show in the page instead.
    const problems: string[] = [];
    page.on("console", (m) => m.type() === "error" && !/status of 403/.test(m.text()) && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(e.message));
    try {
      expect(await runScenario(page, `http://127.0.0.1:${(server.address() as { port: number }).port}`)).toEqual(EXPECTED);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});
