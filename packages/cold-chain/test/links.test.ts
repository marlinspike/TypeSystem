import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeLinks } from "@typesys/devkit";
import { buildColdChainHost, coldChainIdentities as who, startService, startServices, type ColdChainHost, type RunningService, type RunningServices } from "../src/index.js";

/**
 * Relationships across systems with no copy between them (ADR-0094): the
 * shipment tracker names each end of a shipment by the pharmacy
 * inventory's facility code, and the runtime reads the Site from the
 * inventory. When the inventory stops answering, a shipment is still read
 * from the tracker, and the links that need the inventory say they could
 * not be resolved.
 */
let services: RunningServices;
let inventory: RunningService;
let host: ColdChainHost;
beforeAll(async () => {
  services = await startServices();
  // The inventory in a process of its own that the test can stop.
  inventory = await startService("pharmacy-inventory");
  host = await buildColdChainHost({ urls: { tracker: services.tracker.url, sensors: services.sensors.url, inventory: inventory.url } });
}, 30_000);
afterAll(async () => {
  await services?.stop();
  await inventory?.stop();
});

describe("links across systems", () => {
  it("reads a shipment's destination Site from the inventory, by the code the tracker holds", async () => {
    const [site] = await host.runtime.getRelationship("coldchain.Shipment", "SH-1046", "destinationSite", who.qa);
    expect(site).toMatchObject({ typeName: "coldchain.Site", objectId: "HOU", values: { name: "Gulf Coast Regional Pharmacy" } });
    const read = await host.runtime.getObject("coldchain.Site", site!.objectId, who.qa, { includeProvenance: true });
    expect(new Set(read.provenance!.map((p) => p.source.dataSourceId))).toEqual(new Set(["pharmacy-inventory"]));
    const included = await host.runtime.query({ type: "coldchain.Shipment", filter: { property: "status", operator: "eq", value: "held" }, include: [{ relationship: "originSite" }, { relationship: "destinationSite" }] }, who.qa);
    const held = included.items[0]!;
    const end = (name: string) => (held.values[name] as { objectId: string }[])[0]!.objectId;
    expect([held.objectId, end("originSite"), end("destinationSite")]).toEqual(["SH-1048", "MEM", "ATL"]);
  });

  it("probes every cross-system link, and names the systems each crosses", async () => {
    const p = await probeLinks(host.runtime, who.qa, { as: who.logistics, types: ["coldchain.Shipment"], crossSourceOnly: true });
    const site = p.relationships.find((r) => r.relationship === "destinationSite")!;
    expect(site.crossSource).toEqual({ from: "shipment-tracker", through: "shipment-tracker", target: "pharmacy-inventory" });
    expect(p.relationships.find((r) => r.relationship === "readings")?.crossSource).toEqual({ from: "shipment-tracker", through: "sensor-hub", target: "sensor-hub" });
    expect([site.probed, site.returned, site.dangling, site.unavailable]).toEqual([3, 3, 0, 0]);
  });

  it("when the inventory stops answering, still reads the shipment, and says which links could not be resolved", async () => {
    await inventory.stop();
    const shipment = await host.runtime.getObject("coldchain.Shipment", "SH-1046", who.qa);
    expect(shipment.values.destination).toBe("HOU");
    const p = await probeLinks(host.runtime, who.qa, { types: ["coldchain.Shipment"] });
    const byName = Object.fromEntries(p.relationships.map((r) => [r.relationship, r]));
    expect([byName.destinationSite!.unavailable, byName.lots!.unavailable]).toEqual([3, 3]);
    expect(byName.readings!.unavailable).toBe(0);
    expect(byName.destinationSite!.examples[0]).toMatchObject({ outcome: "unavailable" });
    // An include of an optional link the source cannot answer is left out and reported, not an error (ADR-0072),
    // naming the system that did not answer, not the one the link is resolved through.
    const r = await host.runtime.query({ type: "coldchain.Shipment", limit: 1, include: [{ relationship: "destinationSite" }] }, who.qa);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.unavailable).toContainEqual(expect.objectContaining({ path: "destinationSite", dataSourceId: "pharmacy-inventory" }));
  }, 30_000);
});
