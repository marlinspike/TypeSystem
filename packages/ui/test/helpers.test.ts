import { describe, expect, it } from "vitest";
import { fillPath, formatValue, humanize, Invalidation, keyOf, matchPath, toNumber, toText } from "../src/index.js";

/** The parts of `@typesys/ui` that decide without a browser: formatting, routing and freshness (ADR-0082). */
describe("@typesys/ui helpers", () => {
  it("keeps codes as they are and humanizes names", () => {
    expect(humanize("PMC")).toBe("PMC");
    expect(humanize("in_transit")).toBe("In transit");
    expect(humanize("excursionMinutes")).toBe("Excursion minutes");
    expect(formatValue("NMC", "badge")).toBe("NMC");
  });

  it("never writes an unknown value as text", () => {
    expect(toText(undefined)).toBeUndefined();
    expect(toText(null)).toBeUndefined();
    expect(toText(3)).toBe("3");
    expect(toNumber("3")).toBeUndefined();
    expect(toNumber(Number.NaN)).toBeUndefined();
    expect(keyOf({ $id: "S-1" }, 4)).toBe("S-1");
    expect(keyOf({ group: "a" }, 4)).toBe("4");
  });

  it("matches and fills page paths, each parameter encoded", () => {
    expect(matchPath("/shipments/:id", "/shipments/S%2F1")).toEqual({ id: "S/1" });
    expect(matchPath("/shipments/:id", "/shipments")).toBeUndefined();
    expect(matchPath("/shipments/:id", "/shipments/%E0%A4%A")).toBeUndefined();
    expect(fillPath("/shipments/:id", { id: "S/1" })).toBe("/shipments/S%2F1");
    // P4-18: a missing parameter is no path, not a path to no page.
    expect(fillPath("/shipments/:id", {})).toBeUndefined();
    expect(fillPath("/shipments/:id", { id: "" })).toBeUndefined();
  });

  it("refreshes only reads of the Types a change names", () => {
    const bus = new Invalidation();
    const seen: string[] = [];
    const off = bus.subscribe(["coldchain.Lot"], () => seen.push("lots"));
    bus.subscribe(["coldchain.Shipment"], () => seen.push("shipments"));
    bus.publish(["coldchain.Lot"]);
    off();
    bus.publish(["coldchain.Lot", "coldchain.Shipment"]);
    expect(seen).toEqual(["lots", "shipments"]);
  });
});
