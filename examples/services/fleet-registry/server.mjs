// fleet-registry: an independent aircraft registry service, written without
// TypeSystem. Its own data model (tail_no, mds, mc_status), its own
// authorization (API keys with scopes), cursor paging. Plain Node, no
// dependencies, so it stands in for a system TypeSystem did not build.
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";

const AIRFRAMES = [
  { tail_no: "AF86-0147", mds: "F-16C", unit: "388FW", base: "KHIF", mc_status: "PMC", updated: "2026-10-12T08:00:00Z" },
  { tail_no: "AF87-0212", mds: "F-16C", unit: "388FW", base: "KHIF", mc_status: "FMC", updated: "2026-10-12T08:00:00Z" },
  { tail_no: "AF88-0405", mds: "F-16C", unit: "388FW", base: "KHIF", mc_status: "NMC", updated: "2026-10-11T17:30:00Z" },
  { tail_no: "AF09-4126", mds: "F-35A", unit: "419FW", base: "KHIF", mc_status: "FMC", updated: "2026-10-12T06:15:00Z" },
  { tail_no: "AF12-5052", mds: "F-35A", unit: "33FW", base: "KVPS", mc_status: "PMC", updated: "2026-10-10T12:00:00Z" }
];

/** Keys this service issued, and what each may do. */
const KEYS = { "fleet-reader-key": ["airframes:read"] };

/**
 * @param {{ latencyMs?: number, failing?: boolean }} [options]
 */
export function createFleetRegistry(options = {}) {
  const state = { latencyMs: options.latencyMs ?? 0, failing: options.failing ?? false, calls: 0 };
  const server = createHttpServer(async (req, res) => {
    state.calls++;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
    if (state.failing) return send(503, { error: "maintenance window" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(200, { ok: true });
    const auth = /^ApiKey (.+)$/.exec(req.headers.authorization ?? "");
    const scopes = auth ? KEYS[auth[1]] : undefined;
    if (!scopes) return send(401, { error: "missing or unknown API key" });
    if (!scopes.includes("airframes:read")) return send(403, { error: "scope airframes:read required" });

    const one = /^\/v1\/airframes\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const found = AIRFRAMES.find((a) => a.tail_no === decodeURIComponent(one[1]));
      return found ? send(200, found) : send(404, { error: "no such airframe" });
    }
    if (url.pathname === "/v1/airframes") {
      let rows = AIRFRAMES;
      for (const key of ["unit", "base", "mds", "mc_status"]) {
        const v = url.searchParams.get(key);
        if (v !== null) rows = rows.filter((a) => a[key] === v);
      }
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const size = Math.min(Number(url.searchParams.get("page_size") ?? 2), 50);
      const data = rows.slice(start, start + size);
      return send(200, { data, next: start + size < rows.length ? String(start + size) : null });
    }
    send(404, { error: "not found" });
  });
  return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Started by a parent that pipes our stdin: exit when it does, however it ends.
  if (process.env.EXIT_WITH_PARENT === "1") process.stdin.on("close", () => process.exit(0)).resume();
  const { server } = createFleetRegistry({ latencyMs: Number(process.env.LATENCY_MS ?? 0) });
  server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`fleet-registry on http://127.0.0.1:${server.address().port}`));
}
