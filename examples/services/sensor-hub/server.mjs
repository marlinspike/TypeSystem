// sensor-hub: an independent IoT telemetry service for temperature loggers,
// written without TypeSystem. Its own data model (consignments, logger
// serials, sequence numbers, excursion bands in capitals), its own
// authorization: OAuth 2.0 client credentials (RFC 6749 §4.4) with scopes.
// telemetry.read reads; excursions.write records a disposition. Readings
// are paged by cursor, 24 a page. Times are relative to when it starts.
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";

const MINUTE = 60_000;
const INTERVAL = 15;

/** Each consignment's logger, when it started recording (hours from now), and how many readings it has sent. */
const CONSIGNMENTS = [
  { consignment: "SH-1040", logger: "TL-88-0412", startH: -40, count: 48 },
  { consignment: "SH-1042", logger: "TL-88-0419", startH: -12, count: 48 },
  { consignment: "SH-1043", logger: "TL-88-0420", startH: -30, count: 40 },
  { consignment: "SH-1044", logger: "TL-91-0007", startH: -12, count: 48 },
  { consignment: "SH-1045", logger: "TL-91-0011", startH: -12, count: 48 },
  { consignment: "SH-1046", logger: "TL-88-0433", startH: -12, count: 48 },
  { consignment: "SH-1047", logger: "TL-91-0016", startH: -12, count: 48 },
  { consignment: "SH-1048", logger: "TL-88-0440", startH: -2, count: 8 }
];

/** Readings outside 2–8 °C, by consignment and reading index, and the excursion each window is. */
const WINDOWS = [
  { exc_id: "EX-299", consignment: "SH-1040", from: 10, temps: [8.6, 8.3], band: "MINOR", state: "CLOSED", disposition: "release", note: "Within the manufacturer's stability budget." },
  { exc_id: "EX-301", consignment: "SH-1042", from: 30, temps: [9.2, 10.8, 11.4, 9.6], band: "MAJOR", state: "OPEN" },
  { exc_id: "EX-302", consignment: "SH-1044", from: 40, temps: [8.9], band: "MINOR", state: "OPEN" },
  { exc_id: "EX-303", consignment: "SH-1046", from: 20, temps: [1.4, 0.2, -0.9, -1.8, -1.2, 0.4, 1.6], band: "CRITICAL", state: "OPEN" }
];

const CLIENTS = {
  "typesys-coldchain": { secret: "coldchain-secret", scopes: ["telemetry.read", "excursions.write"] },
  "ops-dashboard": { secret: "dashboard-secret", scopes: ["telemetry.read"] }
};
const DISPOSITIONS = ["release", "quarantine", "destroy"];
const PAGE = 24;

/** A logger's steady reading: about 4.6 °C, a slow swing and a little noise, the same every run. */
const steady = (i) => Math.round((4.6 + 0.7 * Math.sin(i / 5) + (((i * 37) % 11) - 5) / 25) * 10) / 10;

function build(now) {
  const readings = [];
  for (const c of CONSIGNMENTS) {
    const start = now + c.startH * 60 * MINUTE;
    const w = WINDOWS.find((x) => x.consignment === c.consignment);
    for (let i = 0; i < c.count; i++) {
      const out = w && i >= w.from && i < w.from + w.temps.length ? w.temps[i - w.from] : undefined;
      readings.push({ seq: `${c.consignment}-${String(i).padStart(2, "0")}`, consignment: c.consignment, logger: c.logger, ts: new Date(start + i * INTERVAL * MINUTE).toISOString(), temp_c: out ?? steady(i) });
    }
  }
  const excursions = WINDOWS.map((w) => {
    const c = CONSIGNMENTS.find((x) => x.consignment === w.consignment);
    const start = now + c.startH * 60 * MINUTE + w.from * INTERVAL * MINUTE;
    const extreme = w.temps.reduce((a, t) => (Math.abs(t - 5) > Math.abs(a - 5) ? t : a), w.temps[0]);
    return {
      exc_id: w.exc_id,
      consignment: w.consignment,
      logger: c.logger,
      began: new Date(start).toISOString(),
      ended: new Date(start + w.temps.length * INTERVAL * MINUTE).toISOString(),
      peak_c: extreme,
      minutes_out: w.temps.length * INTERVAL,
      band: w.band,
      state: w.state,
      disposition: w.disposition ?? null,
      note: w.note ?? null
    };
  });
  return { readings, excursions };
}

async function body(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  if ((req.headers["content-type"] ?? "").includes("application/json")) return JSON.parse(text || "{}");
  return Object.fromEntries(new URLSearchParams(text));
}

/**
 * @param {{ latencyMs?: number, failing?: boolean, now?: number, tokenTtlMs?: number }} [options]
 */
export function createSensorHub(options = {}) {
  const state = { latencyMs: options.latencyMs ?? 0, failing: options.failing ?? false, calls: 0 };
  const ttl = options.tokenTtlMs ?? 60_000;
  const tokens = new Map();
  const { readings, excursions } = build(options.now ?? Date.now());
  const server = createHttpServer(async (req, res) => {
    state.calls++;
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
    if (state.failing) return send(503, { error: "temporarily_unavailable" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(200, { ok: true });

    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const form = await body(req).catch(() => ({}));
      const client = CLIENTS[form.client_id];
      if (form.grant_type !== "client_credentials" || !client || client.secret !== form.client_secret) return send(401, { error: "invalid_client" });
      const requested = typeof form.scope === "string" ? form.scope.split(" ").filter(Boolean) : client.scopes;
      if (requested.some((s) => !client.scopes.includes(s))) return send(400, { error: "invalid_scope" });
      const token = randomBytes(16).toString("hex");
      tokens.set(token, { scopes: requested, expiresAt: Date.now() + ttl });
      return send(200, { access_token: token, token_type: "Bearer", expires_in: Math.floor(ttl / 1000), scope: requested.join(" ") });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const grant = bearer ? tokens.get(bearer) : undefined;
    if (!grant || grant.expiresAt <= Date.now()) return send(401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
    if (!grant.scopes.includes("telemetry.read")) return send(403, { error: "insufficient_scope" });

    const dispose = /^\/v1\/excursions\/([^/]+)\/disposition$/.exec(url.pathname);
    if (dispose && req.method === "POST") {
      if (!grant.scopes.includes("excursions.write")) return send(403, { error: "insufficient_scope" });
      const found = excursions.find((e) => e.exc_id === decodeURIComponent(dispose[1]));
      if (!found) return send(404, { error: "not_found" });
      if (found.state === "CLOSED") return send(409, { error: "already_dispositioned" });
      const input = await body(req).catch(() => ({}));
      if (!DISPOSITIONS.includes(input.disposition)) return send(400, { error: "invalid_disposition" });
      Object.assign(found, { state: "CLOSED", disposition: input.disposition, note: typeof input.note === "string" ? input.note : null });
      return send(200, found);
    }
    const reopen = /^\/v1\/excursions\/([^/]+)\/reopen$/.exec(url.pathname);
    if (reopen && req.method === "POST") {
      if (!grant.scopes.includes("excursions.write")) return send(403, { error: "insufficient_scope" });
      const found = excursions.find((e) => e.exc_id === decodeURIComponent(reopen[1]));
      if (!found) return send(404, { error: "not_found" });
      Object.assign(found, { state: "OPEN", disposition: null, note: null });
      return send(200, found);
    }
    const exc = /^\/v1\/excursions\/([^/]+)$/.exec(url.pathname);
    if (exc) {
      const found = excursions.find((e) => e.exc_id === decodeURIComponent(exc[1]));
      return found ? send(200, found) : send(404, { error: "not_found" });
    }
    if (url.pathname === "/v1/excursions") {
      const consignment = url.searchParams.get("consignment");
      const st = url.searchParams.get("state");
      return send(200, { excursions: excursions.filter((e) => (consignment === null || e.consignment === consignment) && (st === null || e.state === st)) });
    }
    const one = /^\/v1\/readings\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const found = readings.find((r) => r.seq === decodeURIComponent(one[1]));
      return found ? send(200, found) : send(404, { error: "not_found" });
    }
    if (url.pathname === "/v1/readings") {
      const consignment = url.searchParams.get("consignment");
      const matching = readings.filter((r) => consignment === null || r.consignment === consignment);
      const after = url.searchParams.get("after");
      const start = after === null ? 0 : matching.findIndex((r) => r.seq === after) + 1;
      const size = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? PAGE) || PAGE));
      const page = matching.slice(start, start + size);
      return send(200, { readings: page, next_cursor: start + size < matching.length ? page[page.length - 1].seq : null });
    }
    send(404, { error: "not_found" });
  });
  return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Started by a parent that pipes our stdin: exit when it does, however it ends.
  if (process.env.EXIT_WITH_PARENT === "1") process.stdin.on("close", () => process.exit(0)).resume();
  const { server } = createSensorHub({ latencyMs: Number(process.env.LATENCY_MS ?? 0) });
  server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`sensor-hub on http://127.0.0.1:${server.address().port}`));
}
