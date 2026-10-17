// recall-exchange: an independent manufacturer recall notification
// exchange, written without TypeSystem. Manufacturers post recall notices
// here; each distributor that subscribes reads the notices and files one
// effectiveness response per notice, saying what it held. Its own data
// model (recall numbers, issuing firms, eleven-digit NDCs without hyphens,
// affected lot codes, hazard classes and states in capitals, a response
// nested on the notice, a `{ data, meta }` envelope and `{ error: { code } }`
// errors), its own authorization (HTTP Basic, a client id and secret per
// subscriber; the viewer client sees public notices only and may not
// respond), and page-numbered paging, two notices a page.
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";

/**
 * The notices posted to this distributor. Lot codes are the distributor's
 * own lot numbers as the manufacturer shipped them; an NDC is written as its
 * eleven digits. A lot on a notice the distributor never held is listed all
 * the same: a manufacturer recalls every lot it made, not every lot one
 * distributor bought.
 */
const NOTICES = [
  {
    recallNumber: "RCL-26-0412",
    issuingFirm: "Northwind Biologics",
    product: { name: "COVID-19 mRNA vaccine", ndc11: "80777027310" },
    affectedLots: [
      { lotCode: "L-7701", expiry: "2027-03-31" },
      { lotCode: "L-7731", expiry: "2027-04-30" },
      { lotCode: "L-7795", expiry: "2027-05-31" }
    ],
    hazardClass: "CLASS_II",
    hazardEvaluation: "Stability testing at month 9 found potency below specification in three lots filled on line 4; temporary or medically reversible effects (reduced protection) are possible.",
    disclosure: "PUBLIC",
    lifecycle: "ACTIVE",
    issuedOn: "2026-10-15",
    responseState: "PENDING",
    response: null
  },
  {
    recallNumber: "RCL-26-0388",
    issuingFirm: "Helix Pharma",
    product: { name: "Insulin glargine", ndc11: "00088222033" },
    affectedLots: [{ lotCode: "L-7740", expiry: "2027-01-31" }],
    hazardClass: "CLASS_I",
    hazardEvaluation: "Particulate matter found in retained samples; injection could cause serious adverse health consequences. Not yet disclosed by the regulator.",
    disclosure: "EMBARGOED",
    lifecycle: "ACTIVE",
    issuedOn: "2026-10-16",
    responseState: "PENDING",
    response: null
  },
  {
    recallNumber: "RCL-26-0405",
    issuingFirm: "Cascadia Vaccines",
    product: { name: "RSV vaccine", ndc11: "58160084811" },
    affectedLots: [
      { lotCode: "L-7745", expiry: "2027-02-28" },
      { lotCode: "L-7720", expiry: "2027-06-30" }
    ],
    hazardClass: "CLASS_II",
    hazardEvaluation: "Container closure integrity failure in a packaging run; sterility cannot be assured.",
    disclosure: "PUBLIC",
    lifecycle: "ACTIVE",
    issuedOn: "2026-10-14",
    responseState: "PENDING",
    response: null
  },
  {
    recallNumber: "RCL-26-0420",
    issuingFirm: "Helix Pharma",
    product: { name: "MMR vaccine", ndc11: "00006468100" },
    affectedLots: [{ lotCode: "L-7770", expiry: "2027-09-30" }],
    hazardClass: "CLASS_III",
    hazardEvaluation: "Carton labels misprint the storage statement; the product itself is unaffected and use is unlikely to cause harm.",
    disclosure: "PUBLIC",
    lifecycle: "ACTIVE",
    issuedOn: "2026-10-16",
    responseState: "PENDING",
    response: null
  },
  {
    recallNumber: "RCL-26-0360",
    issuingFirm: "Cascadia Vaccines",
    product: { name: "Zoster vaccine, recombinant", ndc11: "58160081912" },
    affectedLots: [{ lotCode: "L-7760", expiry: "2027-05-31" }],
    hazardClass: "CLASS_III",
    hazardEvaluation: "Package insert omitted a revised storage statement.",
    disclosure: "PUBLIC",
    lifecycle: "ACTIVE",
    issuedOn: "2026-10-01",
    responseState: "RECEIVED",
    response: { receivedAt: "2026-10-02T14:05:00.000Z", lotsQuarantined: [], dosesQuarantined: 0, shipmentsInTransit: [], signedOffBy: "Dr. Priya Raman" }
  },
  {
    recallNumber: "RCL-25-0990",
    issuingFirm: "Northwind Biologics",
    product: { name: "Adalimumab", ndc11: "00074055402" },
    affectedLots: [{ lotCode: "L-7751", expiry: "2026-12-31" }],
    hazardClass: "CLASS_II",
    hazardEvaluation: "Out-of-specification aggregate levels; the investigation found a test-method error and the product within specification.",
    disclosure: "PUBLIC",
    lifecycle: "TERMINATED",
    issuedOn: "2025-12-09",
    responseState: "PENDING",
    response: null
  }
];

/** Subscribers, by HTTP Basic client id. The viewer client reads public notices only and may not respond. */
const CLIENTS = {
  "coldchain-distributor": { secret: "rx-exchange-2026", embargoed: true, respond: true },
  "coldchain-viewer": { secret: "rx-view-only", embargoed: false, respond: false }
};
const PAGE_SIZE = 2;

async function body(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || "{}");
}

function client(header) {
  const m = /^Basic (.+)$/.exec(header ?? "");
  if (!m) return undefined;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return undefined;
  const id = decoded.slice(0, i);
  const found = Object.hasOwn(CLIENTS, id) ? CLIENTS[id] : undefined;
  return found && found.secret === decoded.slice(i + 1) ? { id, ...found } : undefined;
}

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * @param {{ latencyMs?: number, failing?: boolean }} [options]
 */
export function createRecallExchange(options = {}) {
  const state = { latencyMs: options.latencyMs ?? 0, failing: options.failing ?? false, calls: 0, responsesFiled: 0 };
  // Each server has its own copy, so a response filed in one test is not seen by another.
  const notices = NOTICES.map((n) => structuredClone(n));
  const server = createHttpServer(async (req, res) => {
    state.calls++;
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const error = (status, code, message, headers) => send(status, { error: { code, message } }, headers);
    if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
    if (state.failing) return error(503, "UNAVAILABLE", "the exchange is offline");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return send(200, { data: { status: "up" } });
    const who = client(req.headers.authorization);
    if (!who) return error(401, "UNAUTHENTICATED", "unknown client or wrong secret", { "www-authenticate": 'Basic realm="recall-exchange"' });
    const visible = (n) => who.embargoed || n.disclosure === "PUBLIC";

    const respond = /^\/exchange\/v1\/notices\/([^/]+)\/responses$/.exec(url.pathname);
    if (respond) {
      const found = notices.find((n) => n.recallNumber === decodeURIComponent(respond[1]));
      if (!found || !visible(found)) return error(404, "NOT_FOUND", "no such notice");
      if (req.method === "GET") return send(200, { data: found.response ? [found.response] : [] });
      if (req.method !== "POST") return error(405, "METHOD_NOT_ALLOWED", "GET or POST");
      if (!who.respond) return error(403, "FORBIDDEN", "this client may not file responses");
      if (found.lifecycle === "TERMINATED") return error(409, "NOTICE_TERMINATED", "the manufacturer terminated this recall");
      if (found.responseState === "RECEIVED") return error(409, "ALREADY_RESPONDED", "a response is already on file for this notice");
      const input = await body(req).catch(() => null);
      if (!input || typeof input !== "object") return error(400, "INVALID_BODY", "a JSON object is required");
      const { lotsQuarantined, dosesQuarantined, shipmentsInTransit, signedOffBy } = input;
      if (!isStringArray(lotsQuarantined) || !isStringArray(shipmentsInTransit) || !Number.isInteger(dosesQuarantined) || dosesQuarantined < 0 || typeof signedOffBy !== "string" || signedOffBy.trim() === "") {
        return error(400, "INVALID_BODY", "lotsQuarantined (string[]), dosesQuarantined (integer >= 0), shipmentsInTransit (string[]) and signedOffBy (non-empty string) are required");
      }
      const listed = new Set(found.affectedLots.map((l) => l.lotCode));
      const stray = lotsQuarantined.filter((l) => !listed.has(l));
      if (stray.length > 0) return error(422, "LOT_NOT_ON_NOTICE", `not on this notice: ${stray.join(", ")}`);
      const response = { receivedAt: new Date().toISOString(), lotsQuarantined: [...lotsQuarantined], dosesQuarantined, shipmentsInTransit: [...shipmentsInTransit], signedOffBy };
      Object.assign(found, { responseState: "RECEIVED", response });
      state.responsesFiled++;
      return send(201, { data: response });
    }
    if (req.method !== "GET") return error(405, "METHOD_NOT_ALLOWED", "read-only resource");

    const one = /^\/exchange\/v1\/notices\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const found = notices.find((n) => n.recallNumber === decodeURIComponent(one[1]));
      return found && visible(found) ? send(200, { data: found }) : error(404, "NOT_FOUND", "no such notice");
    }
    if (url.pathname === "/exchange/v1/notices") {
      const p = url.searchParams;
      const want = (name, actual) => p.get(name) === null || p.get(name) === actual;
      const matching = notices.filter(
        (n) => visible(n) && want("issuingFirm", n.issuingFirm) && want("ndc11", n.product.ndc11) && want("lifecycle", n.lifecycle) && want("disclosure", n.disclosure) && want("responseState", n.responseState) && (p.get("lotCode") === null || n.affectedLots.some((l) => l.lotCode === p.get("lotCode")))
      );
      const pageSize = Math.max(1, Math.min(50, Number(p.get("pageSize") ?? PAGE_SIZE) || PAGE_SIZE));
      const page = Math.max(1, Number(p.get("page") ?? 1) || 1);
      const data = matching.slice((page - 1) * pageSize, page * pageSize);
      return send(200, { data, meta: { page, pageSize, total: matching.length, hasMore: page * pageSize < matching.length } });
    }
    error(404, "NOT_FOUND", "no such resource");
  });
  return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Started by a parent that pipes our stdin: exit when it does, however it ends.
  if (process.env.EXIT_WITH_PARENT === "1") process.stdin.on("close", () => process.exit(0)).resume();
  const { server } = createRecallExchange({ latencyMs: Number(process.env.LATENCY_MS ?? 0) });
  server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`recall-exchange on http://127.0.0.1:${server.address().port}`));
}
