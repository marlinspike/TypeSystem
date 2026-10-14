import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterUnavailableError, SourceRefusedError, isRetryableError } from "@typesys/core";
import { HttpAdapter, type HttpAdapterConfig } from "../src/index.js";

/**
 * Pressure test 3 (P3) of the declarative HTTP adapter (ADR-0072). Each test
 * states what the ADR or the adapter's own documentation promises and fails
 * on the reviewed head (identical to PR #14).
 */

type Route = (url: URL, init: RequestInit) => { status: number; body?: unknown };

function stub(route: Route) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchStub = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    const { status, body } = route(url, init);
    return new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchStub, calls };
}

const RECORDS = [
  { tail_no: "A1", mds: "F-16C" },
  { tail_no: "A2", mds: "F-16C" },
  { tail_no: "A3", mds: "F-35A" }
];

const aircraft = (extra: Partial<HttpAdapterConfig["types"][string]["list"]> = {}): HttpAdapterConfig["types"] => ({
  "t.Aircraft": {
    get: "/a/{id}",
    list: { path: "/a", items: "/data", next: "/next", cursorParam: "c", ...extra },
    id: "/tail_no",
    fields: { mds: "/mds" }
  }
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(handler: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body?: string }): Promise<number> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const out = handler(req, body);
      res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(out.body ?? "");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as { port: number }).port;
}

describe("P3 HttpAdapter: credentials", () => {
  it("P3-H1: a service's redirect to another origin does not receive TypeSystem's header credential (the depot key)", async () => {
    const seen: { url: string; key: string | undefined }[] = [];
    // Another origin (localhost, not 127.0.0.1): whatever the service redirects to.
    const other = await listen((req) => {
      seen.push({ url: req.url ?? "", key: req.headers["x-depot-key"] as string | undefined });
      return { status: 200, body: JSON.stringify({ doc_no: "D1", qty: 1 }) };
    });
    const service = await listen(() => ({ status: 302, headers: { location: `http://localhost:${other}/collect` } }));
    const adapter = new HttpAdapter({
      dataSourceId: "depot",
      system: "Depot",
      baseUrl: `http://127.0.0.1:${service}`,
      auth: { kind: "header", name: "x-depot-key", value: "depot-hill-key" },
      types: { "t.Req": { get: "/r/{id}", list: { path: "/r", items: "/items" }, id: "/doc_no", fields: { quantity: "/qty" } } }
    });
    await adapter.resolveProperties("t.Req", "D1", []).catch(() => undefined);
    expect(seen.filter((s) => s.key !== undefined)).toEqual([]);
  });

  it("P3-H1b: a token endpoint's 307 to another origin does not receive the OAuth client secret", async () => {
    const bodies: string[] = [];
    const other = await listen((_req, body) => {
      bodies.push(body);
      return { status: 200, body: JSON.stringify({ access_token: "t", expires_in: 60 }) };
    });
    const service = await listen((req) =>
      req.url === "/oauth/token" ? { status: 307, headers: { location: `http://localhost:${other}/oauth/token` } } : { status: 404, body: "{}" }
    );
    const adapter = new HttpAdapter({
      dataSourceId: "roster",
      system: "Roster",
      baseUrl: `http://127.0.0.1:${service}`,
      auth: { kind: "client-credentials", tokenUrl: `http://127.0.0.1:${service}/oauth/token`, clientId: "typesys-ops", clientSecret: "ops-secret" },
      types: { "t.Crew": { get: "/m/{id}", list: { path: "/m", items: "/members" }, id: "/id", fields: { callsign: "/callsign" } } }
    });
    await adapter.resolveProperties("t.Crew", "C-1", []).catch(() => undefined);
    expect(bodies.filter((b) => b.includes("ops-secret"))).toEqual([]);
  });

  it("P3-H2: a token endpoint that answers 200 with something that is not JSON is an AdapterUnavailableError, not a bare SyntaxError", async () => {
    const { fetchStub } = stub((url) => (url.pathname === "/token" ? { status: 200, body: "<html>proxy login</html>" } : { status: 200, body: RECORDS[0] }));
    const adapter = new HttpAdapter({
      dataSourceId: "fleet",
      system: "Fleet",
      baseUrl: "http://fleet.test",
      auth: { kind: "client-credentials", tokenUrl: "http://fleet.test/token", clientId: "c", clientSecret: "s" },
      fetch: fetchStub,
      types: aircraft()
    });
    // ADR-0072: "The service did not answer usefully (5xx, a connection error, non-JSON) → AdapterUnavailableError".
    await expect(adapter.resolveProperties("t.Aircraft", "A1", [])).rejects.toBeInstanceOf(AdapterUnavailableError);
  });

  it("P3-H3: a token endpoint that refuses the client with 403 is a SourceRefusedError, as a 403 from the service is", async () => {
    const { fetchStub } = stub((url) => (url.pathname === "/token" ? { status: 403, body: { error: "unauthorized_client" } } : { status: 200, body: RECORDS[0] }));
    const adapter = new HttpAdapter({
      dataSourceId: "fleet",
      system: "Fleet",
      baseUrl: "http://fleet.test",
      auth: { kind: "client-credentials", tokenUrl: "http://fleet.test/token", clientId: "c", clientSecret: "s" },
      fetch: fetchStub,
      types: aircraft()
    });
    // ADR-0072: "The service refused the credential (401, 403) → SourceRefusedError, not retryable".
    await expect(adapter.resolveProperties("t.Aircraft", "A1", [])).rejects.toBeInstanceOf(SourceRefusedError);
  });

  it("P3-H6: a credential in the base URL never appears in an error message (which reaches HTTP problem details and `unavailable`)", async () => {
    const adapter = new HttpAdapter({ dataSourceId: "fleet", system: "Fleet", baseUrl: "http://svc:s3cr3t-pass@127.0.0.1:9/", types: aircraft() });
    const err = await adapter.resolveProperties("t.Aircraft", "A1", []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterUnavailableError);
    expect((err as Error).message).not.toContain("s3cr3t-pass");
  });

  it("P3-H7: concurrent reads share one cached client-credentials token rather than each fetching its own", async () => {
    const { fetchStub, calls } = stub((url) => {
      if (url.pathname === "/token") return { status: 200, body: { access_token: "tok", expires_in: 3600 } };
      const r = RECORDS.find((x) => x.tail_no === decodeURIComponent(url.pathname.slice(3)));
      return r ? { status: 200, body: r } : { status: 404, body: {} };
    });
    const adapter = new HttpAdapter({
      dataSourceId: "fleet",
      system: "Fleet",
      baseUrl: "http://fleet.test",
      auth: { kind: "client-credentials", tokenUrl: "http://fleet.test/token", clientId: "c", clientSecret: "s" },
      fetch: fetchStub,
      types: aircraft()
    });
    // An include fans out concurrently (ADR-0072 "read concurrently"): five reads, one token.
    await Promise.all(["A1", "A2", "A3", "A1", "A2"].map((id) => adapter.resolveProperties("t.Aircraft", id, [])));
    expect(calls.filter((c) => c.url.pathname === "/token")).toHaveLength(1);
  });
});

describe("P3 HttpAdapter: lists and paging", () => {
  it("P3-H4: a service whose next cursor is a number is followed (or refused), never answered from the first page alone", async () => {
    const { fetchStub } = stub((url) => {
      const start = Number(url.searchParams.get("c") ?? 0);
      return { status: 200, body: { data: RECORDS.slice(start, start + 2), next: start + 2 < RECORDS.length ? start + 2 : null } };
    });
    const adapter = new HttpAdapter({ dataSourceId: "fleet", system: "Fleet", baseUrl: "http://fleet.test", fetch: fetchStub, types: aircraft() });
    const outcome = await adapter.queryByType("t.Aircraft").then(
      (r) => r.items.map((i) => i.objectId),
      (e: unknown) => e
    );
    // ADR-0072: "A list larger than maxPages is refused, never answered from a truncated read."
    expect(outcome instanceof AdapterUnavailableError || JSON.stringify(outcome) === JSON.stringify(["A1", "A2", "A3"])).toBe(true);
  });

  it("P3-H4b: a mapping that names a next cursor but no cursorParam is refused, or followed; it never truncates silently", async () => {
    const { fetchStub } = stub((url) => {
      const start = Number(url.searchParams.get("c") ?? 0);
      return { status: 200, body: { data: RECORDS.slice(start, start + 2), next: start + 2 < RECORDS.length ? String(start + 2) : null } };
    });
    const config: HttpAdapterConfig = {
      dataSourceId: "fleet",
      system: "Fleet",
      baseUrl: "http://fleet.test",
      fetch: fetchStub,
      types: { "t.Aircraft": { get: "/a/{id}", list: { path: "/a", items: "/data", next: "/next" }, id: "/tail_no", fields: { mds: "/mds" } } }
    };
    let adapter: HttpAdapter;
    try {
      adapter = new HttpAdapter(config);
    } catch {
      return; // refused at construction: correct
    }
    const outcome = await adapter.queryByType("t.Aircraft").then(
      (r) => r.items.map((i) => i.objectId),
      (e: unknown) => e
    );
    expect(outcome instanceof AdapterUnavailableError || JSON.stringify(outcome) === JSON.stringify(["A1", "A2", "A3"])).toBe(true);
  });

  it("P3-H9: a list over maxPages is a deterministic refusal, not a retryable outage the resilience layer re-reads and counts toward the breaker", async () => {
    const { fetchStub, calls } = stub((url) => {
      const start = Number(url.searchParams.get("c") ?? 0);
      return { status: 200, body: { data: [{ tail_no: `X${start}`, mds: "F-16C" }], next: String(start + 1) } };
    });
    const adapter = new HttpAdapter({ dataSourceId: "fleet", system: "Fleet", baseUrl: "http://fleet.test", fetch: fetchStub, maxPages: 3, types: aircraft() });
    const err = await adapter.queryByType("t.Aircraft").catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    // "narrow the query" is the caller's to fix; retrying it reads the same pages again and again.
    expect(isRetryableError(err)).toBe(false);
  });
});

describe("P3 HttpAdapter: URLs and provenance", () => {
  it("P3-H5: an object id of `..` stays one path segment of the record's path; it never reaches another endpoint", async () => {
    const { fetchStub, calls } = stub(() => ({ status: 404, body: {} }));
    const adapter = new HttpAdapter({ dataSourceId: "fleet", system: "Fleet", baseUrl: "http://fleet.test/v1/", fetch: fetchStub, types: { "t.Aircraft": { ...aircraft()["t.Aircraft"]!, get: "/v1/airframes/{id}/status" } } });
    await adapter.resolveProperties("t.Aircraft", "..", []);
    await adapter.resolveProperties("t.Aircraft", ".", []);
    // Today: GET /v1/status and GET /v1/airframes/status, with TypeSystem's credential. (Percent-encoding the dots
    // would not help: the URL parser treats %2E%2E as `..` too.) Refusing such an id, with no request, is correct.
    expect(calls.map((c) => c.url.pathname).filter((p) => !/^\/v1\/airframes\/[^/]+\/status$/.test(p))).toEqual([]);
  });

  it("P3-H8: provenance names the service's own field for a pointer with an escaped `/` (`/mc~1status` is the field `mc/status`)", async () => {
    const { fetchStub } = stub(() => ({ status: 200, body: { tail_no: "A1", "mc/status": "FMC" } }));
    const adapter = new HttpAdapter({
      dataSourceId: "fleet",
      system: "Fleet",
      baseUrl: "http://fleet.test",
      fetch: fetchStub,
      types: { "t.Aircraft": { get: "/a/{id}", list: { path: "/a", items: "/data" }, id: "/tail_no", fields: { missionCapability: { from: "/mc~1status", map: { FMC: "full" } } } } }
    });
    const r = await adapter.resolveProperties("t.Aircraft", "A1", []);
    expect(r.values).toEqual({ missionCapability: "full" });
    expect(r.provenance[0]?.source.field).toBe("mc/status");
  });
});
