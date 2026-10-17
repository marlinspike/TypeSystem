// pharmacy-inventory: an independent pharmacy and distribution inventory
// service, written without TypeSystem. Its own data model (facility codes,
// lot numbers, NDC product codes, three-letter status codes, storage ranges
// nested per lot), its own authorization (a key in x-pharmacy-key; the
// read-only key may not quarantine or release), and two write endpoints per
// level: one lot, or every lot on a shipment.
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";

const FACILITIES = [
  { facility_code: "MEM", display_name: "Memphis Distribution Center", facility_type: "distribution", city: "Memphis, TN", coords: [35.15, -90.05] },
  { facility_code: "LOU", display_name: "Louisville Cold Hub", facility_type: "distribution", city: "Louisville, KY", coords: [38.25, -85.76] },
  { facility_code: "CHI", display_name: "Lakeshore Medical Center Pharmacy", facility_type: "hospital", city: "Chicago, IL", coords: [41.89, -87.62] },
  { facility_code: "ATL", display_name: "Peachtree Community Clinic", facility_type: "clinic", city: "Atlanta, GA", coords: [33.75, -84.39] },
  { facility_code: "BOS", display_name: "Harborview Hospital Pharmacy", facility_type: "hospital", city: "Boston, MA", coords: [42.36, -71.06] },
  { facility_code: "DEN", display_name: "Front Range Health Pharmacy", facility_type: "hospital", city: "Denver, CO", coords: [39.74, -104.99] },
  { facility_code: "HOU", display_name: "Gulf Coast Regional Pharmacy", facility_type: "hospital", city: "Houston, TX", coords: [29.76, -95.37] },
  { facility_code: "SFO", display_name: "Bayview Clinic", facility_type: "clinic", city: "San Francisco, CA", coords: [37.77, -122.42] }
];

const COLD = { min_c: 2, max_c: 8 };
const LOTS = [
  { lot_no: "L-7701", ndc: "80777-0273-10", product: "COVID-19 mRNA vaccine", mfr: "Northwind Biologics", doses: 1200, unit_cost_usd: 19.5, status: "AVL", expiry: "2027-03-31", facility: "CHI", shipment_ref: "SH-1040", storage: COLD },
  { lot_no: "L-7720", ndc: "49281-0424-50", product: "Influenza vaccine, quadrivalent", mfr: "Cascadia Vaccines", doses: 900, unit_cost_usd: 14.25, status: "AVL", expiry: "2027-06-30", facility: "ATL", shipment_ref: "SH-1043", storage: COLD },
  { lot_no: "L-7731", ndc: "80777-0273-10", product: "COVID-19 mRNA vaccine", mfr: "Northwind Biologics", doses: 1500, unit_cost_usd: 19.5, status: "TRN", expiry: "2027-04-30", facility: "CHI", shipment_ref: "SH-1042", storage: COLD },
  { lot_no: "L-7732", ndc: "49281-0424-50", product: "Influenza vaccine, quadrivalent", mfr: "Cascadia Vaccines", doses: 800, unit_cost_usd: 14.25, status: "TRN", expiry: "2027-06-30", facility: "CHI", shipment_ref: "SH-1042", storage: COLD },
  { lot_no: "L-7740", ndc: "00088-2220-33", product: "Insulin glargine", mfr: "Helix Pharma", doses: 600, unit_cost_usd: 31.8, status: "TRN", expiry: "2027-01-31", facility: "BOS", shipment_ref: "SH-1044", storage: COLD },
  { lot_no: "L-7745", ndc: "58160-0848-11", product: "RSV vaccine", mfr: "Cascadia Vaccines", doses: 400, unit_cost_usd: 148.0, status: "TRN", expiry: "2027-02-28", facility: "DEN", shipment_ref: "SH-1045", storage: COLD },
  { lot_no: "L-7750", ndc: "58160-0821-11", product: "Hepatitis B vaccine", mfr: "Helix Pharma", doses: 1000, unit_cost_usd: 27.6, status: "TRN", expiry: "2027-08-31", facility: "HOU", shipment_ref: "SH-1046", storage: COLD },
  { lot_no: "L-7751", ndc: "00074-0554-02", product: "Adalimumab", mfr: "Northwind Biologics", doses: 120, unit_cost_usd: 2950.0, status: "TRN", expiry: "2026-12-31", facility: "HOU", shipment_ref: "SH-1046", storage: COLD },
  { lot_no: "L-7760", ndc: "58160-0819-12", product: "Zoster vaccine, recombinant", mfr: "Cascadia Vaccines", doses: 500, unit_cost_usd: 196.0, status: "TRN", expiry: "2027-05-31", facility: "SFO", shipment_ref: "SH-1047", storage: COLD },
  { lot_no: "L-7770", ndc: "00006-4681-00", product: "MMR vaccine", mfr: "Helix Pharma", doses: 700, unit_cost_usd: 24.1, status: "TRN", expiry: "2027-09-30", facility: "ATL", shipment_ref: "SH-1048", storage: COLD }
];

/** Keys this inventory issued. */
const KEYS = { "inventory-ops-key": { write: true }, "inventory-readonly-key": { write: false } };

async function body(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || "{}");
}

/**
 * @param {{ latencyMs?: number, failing?: boolean }} [options]
 */
export function createPharmacyInventory(options = {}) {
  const state = { latencyMs: options.latencyMs ?? 0, failing: options.failing ?? false, calls: 0 };
  // Each server has its own copy, so a quarantine in one test is not seen by another.
  const lots = LOTS.map((l) => ({ ...l, held_from: null }));
  const quarantine = (l, reason) => {
    if (l.status === "DST") return false;
    if (l.status !== "QTN") Object.assign(l, { held_from: l.status, status: "QTN", hold_reason: reason ?? null });
    return true;
  };
  const release = (l) => {
    if (l.status === "QTN") Object.assign(l, { status: l.held_from ?? "AVL", held_from: null, hold_reason: null });
  };
  const shown = ({ held_from: _held, ...l }) => l;
  const server = createHttpServer(async (req, res) => {
    state.calls++;
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
    if (state.failing) return send(503, { error: "inventory offline" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(200, { ok: true });
    const key = KEYS[req.headers["x-pharmacy-key"] ?? ""];
    if (!key) return send(401, { error: "unknown key" });

    if (req.method === "POST") {
      if (!key.write) return send(403, { error: "this key is read-only" });
      const input = await body(req).catch(() => ({}));
      const lotWrite = /^\/api\/lots\/([^/]+)\/(quarantine|release)$/.exec(url.pathname);
      if (lotWrite) {
        const found = lots.find((l) => l.lot_no === decodeURIComponent(lotWrite[1]));
        if (!found) return send(404, { error: "no such lot" });
        if (lotWrite[2] === "quarantine" && !quarantine(found, input.reason)) return send(409, { error: "the lot was destroyed" });
        if (lotWrite[2] === "release") release(found);
        return send(200, shown(found));
      }
      const shipmentWrite = /^\/api\/shipments\/([^/]+)\/(quarantine|release)$/.exec(url.pathname);
      if (shipmentWrite) {
        const ref = decodeURIComponent(shipmentWrite[1]);
        const on = lots.filter((l) => l.shipment_ref === ref);
        if (on.length === 0) return send(404, { error: "no lots on that shipment" });
        for (const l of on) {
          if (shipmentWrite[2] === "quarantine") quarantine(l, input.reason);
          else release(l);
        }
        return send(200, { shipment_ref: ref, lots: on.map((l) => l.lot_no), held: on.filter((l) => l.status === "QTN").length });
      }
      return send(404, { error: "not found" });
    }

    const site = /^\/api\/facilities\/([^/]+)$/.exec(url.pathname);
    if (site) {
      const found = FACILITIES.find((f) => f.facility_code === decodeURIComponent(site[1]));
      return found ? send(200, found) : send(404, { error: "no such facility" });
    }
    if (url.pathname === "/api/facilities") {
      const type = url.searchParams.get("type");
      return send(200, FACILITIES.filter((f) => type === null || f.facility_type === type));
    }
    const lot = /^\/api\/lots\/([^/]+)$/.exec(url.pathname);
    if (lot) {
      const found = lots.find((l) => l.lot_no === decodeURIComponent(lot[1]));
      return found ? send(200, shown(found)) : send(404, { error: "no such lot" });
    }
    if (url.pathname === "/api/lots") {
      const shipment = url.searchParams.get("shipment");
      const facility = url.searchParams.get("facility");
      const status = url.searchParams.get("status");
      const rows = lots.filter((l) => (shipment === null || l.shipment_ref === shipment) && (facility === null || l.facility === facility) && (status === null || l.status === status));
      return send(200, { lots: rows.map(shown), total: rows.length });
    }
    send(404, { error: "not found" });
  });
  return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Started by a parent that pipes our stdin: exit when it does, however it ends.
  if (process.env.EXIT_WITH_PARENT === "1") process.stdin.on("close", () => process.exit(0)).resume();
  const { server } = createPharmacyInventory({ latencyMs: Number(process.env.LATENCY_MS ?? 0) });
  server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`pharmacy-inventory on http://127.0.0.1:${server.address().port}`));
}
