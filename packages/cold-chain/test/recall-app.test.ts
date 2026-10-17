import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationError } from "@typesys/core";
import { compileApp, findChromium, verifyApp } from "@typesys/compiler";
import { buildRecallHost, coldChainUrlsFromEnv, resolveRecallIdentity, type RecallHost } from "../src/index.js";

/**
 * The recall response (examples/apps/recall-response): a fourth system, the
 * recall exchange, added to the cold chain on the same runtime, and the
 * application the showcase's engineer compiled over it. The hidden checks it
 * was scored against live in packages/evaluation.
 */
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/apps/recall-response");
const chrome = findChromium();

describe("the recall host", () => {
  let host: RecallHost;
  beforeAll(async () => {
    host = await buildRecallHost();
  }, 30_000);
  afterAll(async () => host.services?.stop());

  it("reads notices through the exchange's envelope and pages, as each person may", async () => {
    const qa = await resolveRecallIdentity("demo-qa-token");
    const logistics = await resolveRecallIdentity("demo-logistics-token");
    const all = await host.runtime.query({ type: "coldchain.Recall", limit: 50 }, qa);
    expect(all.items.map((i) => i.objectId).sort()).toEqual(["RCL-25-0990", "RCL-26-0360", "RCL-26-0388", "RCL-26-0405", "RCL-26-0412", "RCL-26-0420"]);
    const pub = await host.runtime.query({ type: "coldchain.Recall", limit: 50 }, logistics);
    expect(pub.items.map((i) => i.objectId)).not.toContain("RCL-26-0388");
    const notice = await host.runtime.getObject("coldchain.Recall", "RCL-26-0360", logistics);
    expect(notice.values).toMatchObject({ recallClass: "III", lifecycle: "active", embargoed: false, responseStatus: "responded", signedOffBy: "Dr. Priya Raman" });
    expect(notice.values).not.toHaveProperty("healthHazard");
  });

  it("refuses a carrier's query outright, and resolves the second pharmacist", async () => {
    await expect(host.runtime.query({ type: "coldchain.Recall" }, await resolveRecallIdentity("demo-carrier-token"))).rejects.toThrow(AuthorizationError);
    expect(await resolveRecallIdentity("demo-qa2-token")).toMatchObject({ subjectId: "user-qa-2", roles: ["qa"], clearance: "CONFIDENTIAL" });
  });

  it("never quarantines or files directly: both need an approved workflow step (ADR-0096)", async () => {
    const qa = await resolveRecallIdentity("demo-qa-token");
    await expect(host.runtime.invokeAction("HoldLotsForRecall", { recallId: "RCL-26-0412", lotIds: ["L-7701"] }, qa)).rejects.toThrow(AuthorizationError);
    const lot = await host.runtime.getObject("coldchain.Lot", "L-7701", qa);
    expect(lot.values.status).not.toBe("quarantined");
  });

  it("reads the cold chain's services from the environment when all three are given", () => {
    expect(coldChainUrlsFromEnv({ TYPESYS_COLDCHAIN_TRACKER_URL: "http://t", TYPESYS_COLDCHAIN_SENSORS_URL: "http://s" })).toBeUndefined();
    expect(coldChainUrlsFromEnv({ TYPESYS_COLDCHAIN_TRACKER_URL: "http://t", TYPESYS_COLDCHAIN_SENSORS_URL: "http://s", TYPESYS_COLDCHAIN_INVENTORY_URL: "http://i" })).toEqual({ tracker: "http://t", sensors: "http://s", inventory: "http://i" });
  });
});

describe("the recall response application", () => {
  it("is exactly what the compiler generates from its app.json", async () => {
    const r = await compileApp(APP);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect({ written: r.written, created: r.created, removed: r.removed }).toEqual({ written: [], created: [], removed: [] });
  });

  // Compiles, builds the client and drives Chromium: local, beside `npm run check:full`, never on a pull request's CI.
  it.skipIf(!chrome || process.env.CI !== undefined)("passes every acceptance check against a fresh copy of itself and the four services", async () => {
    const r = await verifyApp(APP);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks).toHaveLength(22);
  }, 300_000);
});
