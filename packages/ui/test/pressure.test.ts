import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { $ } from "@typesys/app";
import { Metric, Table, useDerived, type Data } from "../src/index.js";

/** Findings of the 4.0 pressure test that `@typesys/ui` decides, rendered without a browser. */
const ready = <T>(value: T): Data<T> => ({ status: "ready", value, stale: false, refresh: () => undefined });
const failed: Data<unknown[]> = { status: "error", value: undefined, error: new Error("the sensor hub is down"), stale: false, refresh: () => undefined };

describe("the 4.0 pressure test, in @typesys/ui", () => {
  it("P4-06: a figure computed from a read that failed is unavailable, not a confident 0", () => {
    const lots = ready([{ shipmentId: "SH-1", doses: 40 }]);
    function DosesAtRisk(): ReactElement {
      const atRisk = useDerived(() => $.where(lots.value, (l) => $.inList(l.shipmentId, $.pluck(failed.value as { shipmentId: string }[] | undefined, "shipmentId"))), [lots, failed]);
      return createElement(Metric, { id: "doses-at-risk", label: "Doses at risk", value: $.sum(atRisk.value, "doses"), pending: [atRisk] });
    }
    const html = renderToStaticMarkup(createElement(DosesAtRisk));
    expect(html).toContain('data-state="error"');
    expect(html).toContain("Unavailable");
    expect(html).not.toMatch(/ts-metric-value">0</);
  });

  it("P4-06: data derived from a read with no value yet are not known, whatever the computation makes of nothing", () => {
    function Count(): ReactElement {
      // A computation that turns a missing list into an empty one would otherwise show "0" as settled.
      const open = useDerived(() => failed.value ?? [], [failed]);
      return createElement(Metric, { id: "open", label: "Open", value: $.count(open.value), pending: [open] });
    }
    const html = renderToStaticMarkup(createElement(Count));
    expect(html).toContain("Unavailable");
    expect(html).not.toMatch(/ts-metric-value">0</);
  });

  it("P4-17: a table says how many rows it was given, whatever page of them it shows", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ $id: `SH-${i}`, $type: "coldchain.Shipment", carrier: "Polar Freight" }));
    const html = renderToStaticMarkup(createElement(Table, { id: "shipments-table", data: ready(rows), columns: [{ field: "carrier" }] }));
    expect((html.match(/data-row=/g) ?? []).length).toBe(25);
    expect(html).toContain('data-rows="40"');
  });
});
