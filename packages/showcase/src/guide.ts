import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { QUESTIONS, SERVICES, STAGES, SURFACES, type ServiceKey, type SurfaceKey } from "./catalog.js";
import { DEFAULT_CONFIG, SAMPLE_CONFIGS, describeModels } from "./models.js";
import { guidePage } from "./page.js";
import { ROOT, coldChainModelConfig, type Stack } from "./stack.js";

/** An application's callers, from its app.json: the people the comparison reads as. */
function callersOf(app: "cold-chain" | "recall-response"): { name: string; token: string; description: string }[] {
  const spec = JSON.parse(readFileSync(path.join(ROOT, "examples/apps", app, "app.json"), "utf8")) as { callers: Record<string, { token: string; description: string }> };
  return Object.entries(spec.callers).map(([name, c]) => ({ name, token: c.token, description: c.description }));
}

/** The reads the comparison offers: each one object, chosen because the people reading it are decided differently. */
export const COMPARISONS = {
  embargoed: { app: "recall-response", surface: "recall", type: "coldchain.Recall", id: "RCL-26-0388", why: "An embargoed notice: need-to-know for quality assurance; the health hazard is CONFIDENTIAL." },
  public: { app: "recall-response", surface: "recall", type: "coldchain.Recall", id: "RCL-26-0412", why: "A public notice: the coordinator and auditor read it, without the health hazard." },
  lot: { app: "cold-chain", surface: "coldChain", type: "coldchain.Lot", id: "L-7731", why: "A lot: unit cost is CONFIDENTIAL contract pricing, released by clearance." },
  shipment: { app: "cold-chain", surface: "coldChain", type: "coldchain.Shipment", id: "SH-1046", why: "Another carrier's freight: a carrier's dispatcher reads only their own." }
} as const satisfies Record<string, { app: "cold-chain" | "recall-response"; surface: SurfaceKey; type: string; id: string; why: string }>;

export interface CompareRow {
  readonly as: string;
  readonly who: string;
  readonly status: number;
  /** The fields returned, when the read was allowed. */
  readonly fields?: readonly string[];
  readonly error?: string;
}

async function call(base: string, method: string, url: string, token: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: shown as it came.
  }
  return { status: res.status, json };
}

/** Why a request was refused, from the problem document the API returns (or an older `{error}` body). */
function refusal(r: { status: number; json: unknown }): string {
  const j = (r.json ?? {}) as { reason?: string; detail?: string; title?: string; error?: { message?: string } | string };
  return j.reason ?? j.detail ?? (typeof j.error === "string" ? j.error : j.error?.message) ?? j.title ?? String(r.status);
}

/** One object read as each of the application's callers, through its governed API: what each was returned, or why not. */
export async function compare(key: keyof typeof COMPARISONS): Promise<{ readonly read: (typeof COMPARISONS)[keyof typeof COMPARISONS]; readonly rows: readonly CompareRow[] }> {
  const read = COMPARISONS[key];
  const base = `http://127.0.0.1:${SURFACES[read.surface].port}`;
  const rows = await Promise.all(
    callersOf(read.app).map(async (c): Promise<CompareRow> => {
      try {
        const r = await call(base, "GET", `/objects/${encodeURIComponent(read.type)}/${encodeURIComponent(read.id)}`, c.token);
        const values = (r.json as { values?: Record<string, unknown> })?.values;
        return r.status === 200 && values ? { as: c.name, who: c.description, status: r.status, fields: Object.keys(values).sort() } : { as: c.name, who: c.description, status: r.status, error: refusal(r) };
      } catch (err) {
        return { as: c.name, who: c.description, status: 0, error: (err as Error).message };
      }
    })
  );
  return { read, rows };
}

/** One shipment read across its three systems, as the coordinator: what each answered. The outage panel shows it before and after a stop. */
export async function probe(shipmentId = "SH-1042"): Promise<{ readonly what: string; readonly system: string; readonly status: number; readonly result: string }[]> {
  const base = `http://127.0.0.1:${SURFACES.coldChain.port}`;
  const at = `/objects/coldchain.Shipment/${shipmentId}`;
  const reads = [
    { what: `shipment ${shipmentId}`, system: SERVICES["shipment-tracker"].system, url: at },
    { what: "its temperature readings", system: SERVICES["sensor-hub"].system, url: `${at}/related/readings` },
    { what: "the lots it carries", system: SERVICES["pharmacy-inventory"].system, url: `${at}/related/lots` }
  ];
  return Promise.all(
    reads.map(async (r) => {
      try {
        const got = await call(base, "GET", r.url, "demo-logistics-token");
        const j = (got.json ?? {}) as { values?: { status?: string } };
        const list = Array.isArray(got.json) ? got.json : undefined;
        const result = got.status >= 300 ? refusal(got) : Array.isArray(list) ? `${list.length} returned` : `status ${j.values?.status ?? "?"}`;
        return { what: r.what, system: r.system, status: got.status, result };
      } catch (err) {
        return { what: r.what, system: r.system, status: 0, result: (err as Error).message };
      }
    })
  );
}

export interface WalkStep {
  readonly who: string;
  readonly did: string;
  readonly status: number;
  readonly result: string;
}

/**
 * The recall response, end to end, through the application's own API: the
 * coordinator asks; the coordinator and a carrier try to sign off and are
 * refused; quality assurance tries to quarantine directly and is refused;
 * Dr. Raman signs off; the exchange now holds the response. Run it on a
 * fresh stack (Reset), since a notice can be answered once.
 */
export async function walkWorkflow(recallId = "RCL-26-0412"): Promise<WalkStep[]> {
  const base = `http://127.0.0.1:${SURFACES.recall.port}`;
  const steps: WalkStep[] = [];
  const say = (who: string, did: string, r: { status: number; json: unknown }, result: (j: Record<string, unknown>) => string) =>
    steps.push({ who, did, status: r.status, result: r.status < 300 ? result((r.json ?? {}) as Record<string, unknown>) : refusal(r) });
  const started = await call(base, "POST", "/workflows/coldchain.RespondToRecall/runs", "demo-logistics-token", { input: { recallId } });
  say("Dana Whitfield (logistics)", `asks to respond to ${recallId}`, started, (j) => `run ${String(j.status)}${j.waitingOn ? `, waiting on ${(j.waitingOn as { step: string }).step}` : ""}`);
  const runId = (started.json as { runId?: string }).runId;
  if (!runId) return steps;
  say("Dana Whitfield (logistics)", "tries to sign it off herself", await call(base, "POST", `/workflow-runs/${runId}/approvals/qaSignoff`, "demo-logistics-token", { approved: true }), (j) => String(j.status));
  say("Northline dispatch (carrier)", "tries to sign it off", await call(base, "POST", `/workflow-runs/${runId}/approvals/qaSignoff`, "demo-carrier-token", { approved: true }), (j) => String(j.status));
  say("Dr. Priya Raman (QA)", "tries to quarantine the lots directly, outside the run", await call(base, "POST", "/actions/HoldLotsForRecall/invoke", "demo-qa-token", { recallId, lotIds: ["L-7701"] }), () => "invoked");
  const pending = await call(base, "GET", `/workflow-runs/${runId}/approval`, "demo-qa-token");
  say("Dr. Priya Raman (QA)", "opens what the sign-off presents", pending, (j) => {
    const a = (j.presented as { affected?: { lots?: string[]; doses?: number }; inTransit?: string[] } | undefined) ?? {};
    return `lots ${(a.affected?.lots ?? []).join(", ") || "none"}; ${a.affected?.doses ?? "?"} doses; in transit ${(a.inTransit ?? []).join(", ") || "none"}`;
  });
  say("Dr. Priya Raman (QA)", "signs it off", await call(base, "POST", `/workflow-runs/${runId}/approvals/qaSignoff`, "demo-qa-token", { approved: true }), (j) => `run ${String(j.status)}`);
  const lot = await call(base, "GET", "/objects/coldchain.Lot/L-7701", "demo-qa-token");
  say("Dr. Priya Raman (QA)", "reads lot L-7701 in the pharmacy inventory", lot, (j) => {
    const v = (j.values ?? {}) as { status?: string; holdReason?: string };
    return `${v.status ?? "?"}: ${v.holdReason ?? ""}`;
  });
  const notice = await call(base, "GET", `/objects/coldchain.Recall/${recallId}`, "demo-logistics-token");
  say("Dana Whitfield (logistics)", "reads the notice from the exchange", notice, (j) => {
    const v = (j.values ?? {}) as { responseStatus?: string; lotsHeld?: string[]; dosesHeld?: number; shipmentsInTransit?: string[]; signedOffBy?: string };
    return `${v.responseStatus ?? "?"}: ${(v.lotsHeld ?? []).join(", ")}, ${v.dosesHeld ?? "?"} doses, in transit ${(v.shipmentsInTransit ?? []).join(", ") || "none"}, signed off by ${v.signedOffBy ?? "?"}`;
  });
  return steps;
}

/** Whether each service and surface answers now. */
export async function status(stack: Stack): Promise<{ services: Record<string, boolean>; surfaces: Record<string, boolean> }> {
  const up = async (url: string) => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_500) });
      return true;
    } catch {
      return false;
    }
  };
  const services = Object.fromEntries(await Promise.all((Object.keys(SERVICES) as ServiceKey[]).map(async (k) => [k, stack.services.has(k) && (await up(`http://127.0.0.1:${SERVICES[k].port}/`))] as const)));
  const surfaces = Object.fromEntries(await Promise.all((Object.keys(SURFACES) as SurfaceKey[]).filter((k) => k !== "guide").map(async (k) => [k, await up(`http://127.0.0.1:${SURFACES[k].port}/`)] as const)));
  return { services, surfaces };
}

/** The guide: one page, and the few endpoints its live panels call. Loopback only. */
export function startGuide(stack: Stack, port: number = SURFACES.guide.port, log: (line: string) => void = () => {}): Promise<{ url: string; server: Server }> {
  const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, guidePage(), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/catalog") return send(res, 200, { questions: QUESTIONS, stages: STAGES, surfaces: SURFACES, services: SERVICES });
    if (req.method === "GET" && url.pathname === "/api/status") return send(res, 200, await status(stack));
    if (req.method === "GET" && url.pathname === "/api/compare") {
      const key = url.searchParams.get("read") ?? "embargoed";
      if (!(key in COMPARISONS)) return send(res, 400, { error: `read is one of ${Object.keys(COMPARISONS).join(", ")}` });
      return send(res, 200, await compare(key as keyof typeof COMPARISONS));
    }
    if (req.method === "GET" && url.pathname === "/api/probe") return send(res, 200, { reads: await probe() });
    if (req.method === "POST" && url.pathname === "/api/outage") {
      const service = String(body.service) as ServiceKey;
      if (!(service in SERVICES)) return send(res, 400, { error: `service is one of ${Object.keys(SERVICES).join(", ")}` });
      if (body.down === true) await stack.stopService(service);
      else if (!stack.services.has(service)) await stack.startServiceKey(service);
      log(`${service} ${body.down === true ? "stopped (outage)" : "started"}`);
      return send(res, 200, await status(stack));
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      log("reset: every service and application restarted with its first data");
      await stack.reset(log);
      return send(res, 200, await status(stack));
    }
    if (req.method === "POST" && url.pathname === "/api/workflow") return send(res, 200, { steps: await walkWorkflow(typeof body.recallId === "string" ? body.recallId : undefined) });
    if (req.method === "GET" && url.pathname === "/api/models") {
      const active = coldChainModelConfig();
      const views = [...new Set([active, DEFAULT_CONFIG, ...SAMPLE_CONFIGS])].map((f) => {
        try {
          return { active: f === active, ...describeModels(f) };
        } catch (err) {
          return { active: f === active, file: f, error: (err as Error).message };
        }
      });
      return send(res, 200, { active, views, simulatedRequests: stack.model?.received.length ?? 0 });
    }
    return send(res, 404, { error: "not found" });
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => send(res, 500, { error: err.message }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  });
}
