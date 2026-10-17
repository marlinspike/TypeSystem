// shipment-tracker: an independent cold-chain freight tracking service,
// written without TypeSystem. Its own data model (shipment references,
// facility codes, carrier SCAC codes, two-letter states, a GPS fix), its own
// authorization (an API key per client in x-api-key), and cursor paging
// three shipments a page. Times are relative to when it starts, as a live
// tracker's are.
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";

const HOUR = 3_600_000;

/** @param {number} now */
function shipments(now) {
  const at = (h) => new Date(now + h * HOUR).toISOString();
  return [
    { ref: "SH-1040", from_facility: "MEM", to_facility: "CHI", scac: "NLCF", state: "DL", gps: { lat: 41.89, lng: -87.62 }, departed: at(-40), eta: at(-26) },
    { ref: "SH-1042", from_facility: "MEM", to_facility: "CHI", scac: "NLCF", state: "IT", gps: { lat: 39.8, lng: -89.64 }, departed: at(-12), eta: at(5) },
    { ref: "SH-1043", from_facility: "MEM", to_facility: "ATL", scac: "SBRX", state: "DL", gps: { lat: 33.75, lng: -84.39 }, departed: at(-30), eta: at(-20) },
    { ref: "SH-1044", from_facility: "LOU", to_facility: "BOS", scac: "NLCF", state: "IT", gps: { lat: 42.65, lng: -73.75 }, departed: at(-12), eta: at(3) },
    { ref: "SH-1045", from_facility: "LOU", to_facility: "DEN", scac: "PLRF", state: "IT", gps: { lat: 39.1, lng: -94.58 }, departed: at(-12), eta: at(9) },
    { ref: "SH-1046", from_facility: "MEM", to_facility: "HOU", scac: "SBRX", state: "IT", gps: { lat: 32.52, lng: -93.75 }, departed: at(-12), eta: at(4) },
    { ref: "SH-1047", from_facility: "LOU", to_facility: "SFO", scac: "PLRF", state: "IT", gps: { lat: 40.76, lng: -111.89 }, departed: at(-12), eta: at(20) },
    { ref: "SH-1048", from_facility: "MEM", to_facility: "ATL", scac: "SBRX", state: "HD", gps: { lat: 35.15, lng: -90.05 }, departed: at(-2), eta: at(14) }
  ];
}

/** Keys this tracker issued. A carrier's key sees only its own freight. */
const KEYS = { "tracker-shipper-key": null, "tracker-nlcf-key": "NLCF" };
const PAGE = 3;

/**
 * @param {{ latencyMs?: number, failing?: boolean, now?: number }} [options]
 */
export function createShipmentTracker(options = {}) {
  const state = { latencyMs: options.latencyMs ?? 0, failing: options.failing ?? false, calls: 0 };
  const rows = shipments(options.now ?? Date.now());
  const server = createHttpServer(async (req, res) => {
    state.calls++;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
    if (state.failing) return send(503, { error: "tracker offline" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(200, { ok: true });
    const key = req.headers["x-api-key"] ?? "";
    if (!Object.hasOwn(KEYS, key)) return send(401, { error: "unknown api key" });
    const carrier = KEYS[key];
    const visible = rows.filter((r) => carrier === null || r.scac === carrier);

    const one = /^\/api\/v2\/shipments\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const found = rows.find((r) => r.ref === decodeURIComponent(one[1]));
      if (!found) return send(404, { error: "no such shipment" });
      return visible.includes(found) ? send(200, found) : send(403, { error: "not your freight" });
    }
    if (url.pathname === "/api/v2/shipments") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const st = url.searchParams.get("state");
      const matching = visible.filter((r) => (from === null || r.from_facility === from) && (to === null || r.to_facility === to) && (st === null || r.state === st));
      const start = Number(url.searchParams.get("cursor") ?? 0) || 0;
      const size = Math.max(1, Math.min(50, Number(url.searchParams.get("per_page") ?? PAGE) || PAGE));
      return send(200, { shipments: matching.slice(start, start + size), cursor: start + size < matching.length ? String(start + size) : null });
    }
    send(404, { error: "not found" });
  });
  return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Started by a parent that pipes our stdin: exit when it does, however it ends.
  if (process.env.EXIT_WITH_PARENT === "1") process.stdin.on("close", () => process.exit(0)).resume();
  const { server } = createShipmentTracker({ latencyMs: Number(process.env.LATENCY_MS ?? 0) });
  server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`shipment-tracker on http://127.0.0.1:${server.address().port}`));
}
