// parts-depot: an independent parts requisition service, written without
// TypeSystem. Its own data model (document numbers, NSNs, requisition
// state), its own authorization (a depot key per base: a key sees only the
// requisitions of the bases it was issued for), and two schema versions.
// v1 is flat; v2 nests the aircraft and item, and renames most fields. A
// deployment runs one version at a time (SCHEMA=1|2), as an upgrade would.
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";

const REQUISITIONS = [
  { doc_no: "KHIF-6281-0001", tail: "AF86-0147", nsn: "5895-01-559-0812", noun: "Radar processor", base: "KHIF", qty: 1, status: "in-transit", eta: "2026-10-16" },
  { doc_no: "KHIF-6281-0002", tail: "AF86-0147", nsn: "1560-01-620-3301", noun: "Canopy seal", base: "KHIF", qty: 2, status: "issued", eta: "2026-10-12" },
  { doc_no: "KHIF-6282-0003", tail: "AF88-0405", nsn: "2840-01-472-1563", noun: "Turbine blade set", base: "KHIF", qty: 1, status: "awaiting", eta: "2026-10-30" },
  { doc_no: "KVPS-6280-0001", tail: "AF12-5052", nsn: "6610-01-701-4410", noun: "Air data computer", base: "KVPS", qty: 1, status: "awaiting", eta: "2026-10-21" }
];

/** Keys this depot issued, each for the bases whose requisitions it may see. */
const KEYS = { "depot-hill-key": ["KHIF"], "depot-hq-key": ["KHIF", "KVPS"] };

const v1 = (r) => ({ ...r });
const v2 = (r) => ({
  document_number: r.doc_no,
  aircraft: { tail: r.tail },
  item: { nsn: r.nsn, nomenclature: r.noun },
  location: r.base,
  quantity: r.qty,
  state: r.status.toUpperCase().replace("-", "_"),
  estimated_delivery: r.eta
});

/**
 * @param {{ latencyMs?: number, failing?: boolean, schema?: 1 | 2 }} [options]
 */
export function createPartsDepot(options = {}) {
  const state = { latencyMs: options.latencyMs ?? 0, failing: options.failing ?? false, schema: options.schema ?? 1, calls: 0 };
  const server = createHttpServer(async (req, res) => {
    state.calls++;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
    if (state.failing) return send(503, { error: "depot system offline" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(200, { ok: true, schema: state.schema });
    const bases = KEYS[req.headers["x-depot-key"] ?? ""];
    if (!bases) return send(401, { error: "unknown depot key" });
    const prefix = `/v${state.schema}/requisitions`;
    const shape = state.schema === 1 ? v1 : v2;
    if (!url.pathname.startsWith(prefix)) return send(404, { error: `this depot serves ${prefix}` });

    const one = new RegExp(`^${prefix}/([^/]+)$`).exec(url.pathname);
    if (one) {
      const found = REQUISITIONS.find((r) => r.doc_no === decodeURIComponent(one[1]));
      if (!found) return send(404, { error: "no such requisition" });
      return bases.includes(found.base) ? send(200, shape(found)) : send(403, { error: `this key is not issued for ${found.base}` });
    }
    if (url.pathname === prefix) {
      const tail = url.searchParams.get(state.schema === 1 ? "tail" : "aircraft");
      const base = url.searchParams.get(state.schema === 1 ? "base" : "location");
      if (base !== null && !bases.includes(base)) return send(403, { error: `this key is not issued for ${base}` });
      const rows = REQUISITIONS.filter((r) => bases.includes(r.base) && (base === null || r.base === base) && (tail === null || r.tail === tail));
      return send(200, { [state.schema === 1 ? "items" : "requisitions"]: rows.map(shape) });
    }
    send(404, { error: "not found" });
  });
  return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Started by a parent that pipes our stdin: exit when it does, however it ends.
  if (process.env.EXIT_WITH_PARENT === "1") process.stdin.on("close", () => process.exit(0)).resume();
  const { server } = createPartsDepot({ latencyMs: Number(process.env.LATENCY_MS ?? 0), schema: Number(process.env.SCHEMA ?? 1) === 2 ? 2 : 1 });
  server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`parts-depot on http://127.0.0.1:${server.address().port}`));
}
