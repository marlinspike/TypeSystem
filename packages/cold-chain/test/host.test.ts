import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationError } from "@typesys/core";
import { buildColdChainHost, coldChainIdentities as who, startServices, type ColdChainHost, type RunningServices } from "../src/index.js";

/**
 * The governed model over three services, each in its own process with its
 * own authorization: one vocabulary, policy and classification decided in
 * one place, and a service's own refusal kept a refusal.
 */
let services: RunningServices;
let host: ColdChainHost;
beforeAll(async () => {
  services = await startServices();
  host = await buildColdChainHost({ urls: { tracker: services.tracker.url, sensors: services.sensors.url, inventory: services.inventory.url } });
}, 30_000);
afterAll(async () => services?.stop());

describe("the cold chain host", () => {
  it("translates each service's codes and shapes into one vocabulary", async () => {
    const s = await host.runtime.getObject("coldchain.Shipment", "SH-1046", who.qa);
    expect(s.values).toMatchObject({ origin: "MEM", destination: "HOU", carrier: "Southbridge Reefer", status: "in-transit", lat: 32.52, lon: -93.75 });
    const e = await host.runtime.getObject("coldchain.Excursion", "EX-303", who.qa);
    expect(e.values).toMatchObject({ shipmentId: "SH-1046", severity: "critical", status: "open", peakC: -1.8, minutesOut: 105 });
    const site = await host.runtime.getObject("coldchain.Site", "HOU", who.qa);
    expect(site.values).toMatchObject({ name: "Gulf Coast Regional Pharmacy", lat: 29.76, lon: -95.37 });
  });

  it("withholds contract pricing from anyone not cleared CONFIDENTIAL", async () => {
    expect((await host.runtime.getObject("coldchain.Lot", "L-7751", who.qa)).values.unitCost).toBe(2950);
    const forLogistics = await host.runtime.getObject("coldchain.Lot", "L-7751", who.logistics);
    expect(forLogistics.values).not.toHaveProperty("unitCost");
    expect(forLogistics.values.doses).toBe(120);
  });

  it("shows a carrier only their own freight, and none of the telemetry", async () => {
    const q = await host.runtime.query({ type: "coldchain.Shipment" }, who.carrier);
    expect(q.items.map((i) => i.objectId)).toEqual(["SH-1040", "SH-1042", "SH-1044"]);
    await expect(host.runtime.getObject("coldchain.Shipment", "SH-1046", who.carrier)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(host.runtime.query({ type: "coldchain.Reading" }, who.carrier)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("aggregates a service that has no aggregate endpoint, every page read", async () => {
    const a = await host.runtime.aggregate({ type: "coldchain.Reading", filter: { property: "shipmentId", operator: "eq", value: "SH-1046" }, aggregations: [{ name: "n", op: "count" }, { name: "low", op: "min", property: "temperatureC" }] }, who.logistics);
    expect(a.groups).toEqual([{ key: {}, values: { n: 48, low: -1.8 } }]);
  });

  it("writes back to two services, each through its own credential, and refuses what policy refuses", async () => {
    await expect(host.runtime.invokeAction("QuarantineLot", { lotId: "L-7745", reason: "test" }, who.logistics)).rejects.toBeInstanceOf(AuthorizationError);
    await host.runtime.invokeAction("QuarantineLot", { lotId: "L-7745", reason: "Seal broken on arrival" }, who.qa);
    expect((await host.runtime.getObject("coldchain.Lot", "L-7745", who.qa)).values).toMatchObject({ status: "quarantined", holdReason: "Seal broken on arrival" });
    await host.runtime.invokeAction("ReleaseLot", { lotId: "L-7745" }, who.qa);
    expect((await host.runtime.getObject("coldchain.Lot", "L-7745", who.qa)).values.status).toBe("in-transit");
    const closed = await host.runtime.invokeAction("CloseExcursion", { excursionId: "EX-302", disposition: "release", note: "Within budget" }, who.logistics);
    expect(closed).toMatchObject({ status: "closed", disposition: "release" });
    await host.runtime.invokeAction("ReopenExcursion", { excursionId: "EX-302" }, who.logistics);
    expect((await host.runtime.getObject("coldchain.Excursion", "EX-302", who.qa)).values.status).toBe("open");
  });

  it("keeps a service's own refusal: a read-only inventory key may not quarantine", async () => {
    const readOnly = await buildColdChainHost({ urls: { tracker: services.tracker.url, sensors: services.sensors.url, inventory: services.inventory.url }, inventoryKey: "inventory-readonly-key" });
    await expect(readOnly.runtime.invokeAction("QuarantineLot", { lotId: "L-7740", reason: "test" }, who.qa)).rejects.toThrow(/refused QuarantineLot \(403\)/);
  });
});
