// crew-roster: an independent aircrew roster service, written without
// TypeSystem. Its own data model (members, quals, duty), its own
// authorization: OAuth 2.0 client credentials (RFC 6749 §4.4) issuing
// short-lived bearer tokens with scopes. roster.read lists members;
// full_name is personal data, returned only to a token with roster.pii.
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";

const MEMBERS = [
  { id: "C-1001", callsign: "VIPER", full_name: "Capt Dana Reyes", quals: ["F-16C:IP", "F-16C:FL"], home_unit: "388FW", assigned_tail: "AF86-0147", duty: "available" },
  { id: "C-1002", callsign: "TALON", full_name: "1st Lt Sam Okoro", quals: ["F-16C:WG"], home_unit: "388FW", assigned_tail: "AF86-0147", duty: "available" },
  { id: "C-1003", callsign: "RAVEN", full_name: "Maj Lee Park", quals: ["F-16C:IP", "F-16C:FL"], home_unit: "388FW", assigned_tail: "AF87-0212", duty: "leave" },
  { id: "C-2001", callsign: "GHOST", full_name: "Capt Ana Silva", quals: ["F-35A:FL"], home_unit: "419FW", assigned_tail: "AF09-4126", duty: "available" }
];

/** Clients registered with the roster, and the scopes each may be granted. */
const CLIENTS = {
  "typesys-ops": { secret: "ops-secret", scopes: ["roster.read"] },
  "typesys-ops-pii": { secret: "ops-pii-secret", scopes: ["roster.read", "roster.pii"] }
};

async function body(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  if ((req.headers["content-type"] ?? "").includes("application/json")) return JSON.parse(text || "{}");
  return Object.fromEntries(new URLSearchParams(text));
}

/**
 * @param {{ latencyMs?: number, failing?: boolean, tokenTtlMs?: number }} [options]
 */
export function createCrewRoster(options = {}) {
  const state = { latencyMs: options.latencyMs ?? 0, failing: options.failing ?? false, calls: 0, tokensIssued: 0 };
  const ttl = options.tokenTtlMs ?? 60_000;
  const tokens = new Map();
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
      state.tokensIssued++;
      return send(200, { access_token: token, token_type: "Bearer", expires_in: Math.floor(ttl / 1000), scope: requested.join(" ") });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const grant = bearer ? tokens.get(bearer) : undefined;
    if (!grant || grant.expiresAt <= Date.now()) return send(401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
    if (!grant.scopes.includes("roster.read")) return send(403, { error: "insufficient_scope" });
    const shown = (m) => (grant.scopes.includes("roster.pii") ? m : Object.fromEntries(Object.entries(m).filter(([k]) => k !== "full_name")));

    const one = /^\/api\/members\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const found = MEMBERS.find((m) => m.id === decodeURIComponent(one[1]));
      return found ? send(200, shown(found)) : send(404, { error: "not_found" });
    }
    if (url.pathname === "/api/members") {
      const unit = url.searchParams.get("unit");
      const qual = url.searchParams.get("qual");
      const tail = url.searchParams.get("assigned_tail");
      const rows = MEMBERS.filter((m) => (unit === null || m.home_unit === unit) && (qual === null || m.quals.includes(qual)) && (tail === null || m.assigned_tail === tail));
      return send(200, { members: rows.map(shown), count: rows.length });
    }
    send(404, { error: "not_found" });
  });
  return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Started by a parent that pipes our stdin: exit when it does, however it ends.
  if (process.env.EXIT_WITH_PARENT === "1") process.stdin.on("close", () => process.exit(0)).resume();
  const { server } = createCrewRoster({ latencyMs: Number(process.env.LATENCY_MS ?? 0) });
  server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`crew-roster on http://127.0.0.1:${server.address().port}`));
}
