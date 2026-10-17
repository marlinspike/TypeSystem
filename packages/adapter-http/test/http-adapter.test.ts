import { describe, expect, it } from "vitest";
import { AdapterUnavailableError, SourceRefusedError, type RelationshipDefinition } from "@typesys/core";
import { HttpAdapter, pointer, type HttpAdapterConfig } from "../src/index.js";

/** The declarative HTTP adapter (ADR-0072), against a stub service: mapping, paging, errors and credentials. */
type Route = (url: URL, init: RequestInit) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

function stub(route: Route) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fetchStub = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    const { status, body } = await route(url, init);
    return new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchStub, calls };
}

const RECORDS = [
  { tail_no: "A1", mds: "F-16C", mc_status: "FMC", nested: { unit: "388FW" } },
  { tail_no: "A2", mds: "F-16C", mc_status: "NMC", nested: { unit: "388FW" } },
  { tail_no: "A3", mds: "F-35A", mc_status: "PMC", nested: { unit: "419FW" } }
];

const config = (fetchStub: typeof fetch, extra: Partial<HttpAdapterConfig> = {}): HttpAdapterConfig => ({
  dataSourceId: "fleet",
  system: "Fleet",
  baseUrl: "http://fleet.test",
  auth: { kind: "header", name: "authorization", value: "ApiKey k" },
  fetch: fetchStub,
  types: {
    "t.Aircraft": {
      get: "/a/{id}",
      list: { path: "/a", items: "/data", next: "/next", cursorParam: "c", params: { mds: "mds", missionCapability: "mc" } },
      id: "/tail_no",
      fields: { mds: "/mds", unit: "/nested/unit", missionCapability: { from: "/mc_status", map: { FMC: "full", PMC: "partial", NMC: "none" } } }
    }
  },
  ...extra
});

/** Two records a page, honouring `mds` when given. */
const fleet: Route = (url) => {
  if (url.pathname.startsWith("/a/")) {
    const r = RECORDS.find((x) => x.tail_no === decodeURIComponent(url.pathname.slice(3)));
    return r ? { status: 200, body: r } : { status: 404, body: { error: "nope" } };
  }
  const mds = url.searchParams.get("mds");
  const rows = RECORDS.filter((r) => mds === null || r.mds === mds);
  const start = Number(url.searchParams.get("c") ?? 0);
  return { status: 200, body: { data: rows.slice(start, start + 2), next: start + 2 < rows.length ? String(start + 2) : null } };
};

describe("HttpAdapter", () => {
  it("maps a record onto canonical fields, translating codes, with provenance naming the service's own field", async () => {
    const { fetchStub, calls } = stub(fleet);
    const adapter = new HttpAdapter(config(fetchStub));
    const r = await adapter.resolveProperties("t.Aircraft", "A2", []);
    expect(r.values).toEqual({ mds: "F-16C", unit: "388FW", missionCapability: "none" });
    expect(r.provenance.find((p) => p.propertyPath === "unit")?.source).toEqual({ dataSourceId: "fleet", system: "Fleet", recordId: "A2", field: "nested.unit" });
    expect(calls[0]!.headers.authorization).toBe("ApiKey k");
    expect(await adapter.resolveProperties("t.Aircraft", "missing", [])).toEqual({ values: {}, provenance: [] });
  });

  it("follows every page, pushes only conditions the service holds as-is, and decides every condition itself", async () => {
    const { fetchStub, calls } = stub(fleet);
    const adapter = new HttpAdapter(config(fetchStub));
    const all = await adapter.queryByType("t.Aircraft");
    expect(all.items.map((i) => i.objectId)).toEqual(["A1", "A2", "A3"]);
    // missionCapability is translated, so it is never sent: "none" is not the service's "NMC".
    const none = await adapter.queryByType("t.Aircraft", { and: [{ property: "mds", operator: "eq", value: "F-16C" }, { property: "missionCapability", operator: "eq", value: "none" }] });
    expect(none.items.map((i) => i.objectId)).toEqual(["A2"]);
    expect(calls.at(-1)!.url.searchParams.get("mds")).toBe("F-16C");
    expect(calls.at(-1)!.url.searchParams.has("mc")).toBe(false);
    const page = await adapter.queryByType("t.Aircraft", undefined, 2);
    expect(page).toMatchObject({ nextCursor: "2" });
    expect((await adapter.queryByType("t.Aircraft", undefined, 2, page.nextCursor)).items.map((i) => i.objectId)).toEqual(["A3"]);
  });

  it("aggregates over every page, deciding the filter itself, on translated values", async () => {
    const { fetchStub } = stub(fleet);
    const adapter = new HttpAdapter(config(fetchStub));
    const byMds = await adapter.aggregate({ type: "t.Aircraft", groupBy: ["mds"], aggregations: [{ name: "n", op: "count" }] });
    expect(byMds.groups).toEqual(expect.arrayContaining([{ key: { mds: "F-16C" }, values: { n: 2 } }, { key: { mds: "F-35A" }, values: { n: 1 } }]));
    const capable = await adapter.aggregate({ type: "t.Aircraft", filter: { property: "missionCapability", operator: "ne", value: "none" }, aggregations: [{ name: "n", op: "count" }] });
    expect(capable.groups).toEqual([{ key: {}, values: { n: 2 } }]);
  });

  it("refuses to answer from a truncated list", async () => {
    const { fetchStub } = stub(fleet);
    await expect(new HttpAdapter(config(fetchStub, { maxPages: 1 })).queryByType("t.Aircraft")).rejects.toThrow(AdapterUnavailableError);
  });

  it("keeps a refusal a refusal, and a failure a failure", async () => {
    for (const status of [401, 403]) {
      const { fetchStub } = stub(() => ({ status }));
      const err: unknown = await new HttpAdapter(config(fetchStub)).queryByType("t.Aircraft").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceRefusedError);
      expect((err as SourceRefusedError).dataSourceId).toBe("fleet");
    }
    for (const route of [() => ({ status: 503 }), () => ({ status: 200, body: "<html>" }), () => Promise.reject(new Error("ECONNREFUSED"))] as Route[]) {
      const { fetchStub } = stub(route);
      await expect(new HttpAdapter(config(fetchStub)).resolveProperties("t.Aircraft", "A1", [])).rejects.toThrow(AdapterUnavailableError);
    }
  });

  it("gets a client-credentials token once, reuses it, and renews it once when the service says it expired", async () => {
    let issued = 0;
    let valid = "";
    const { fetchStub, calls } = stub((url, init) => {
      if (url.pathname === "/token") {
        const form = new URLSearchParams(init.body as string);
        if (form.get("client_secret") !== "s") return { status: 401 };
        valid = `tok-${++issued}`;
        return { status: 200, body: { access_token: valid, expires_in: 3600 } };
      }
      return (init.headers as Record<string, string>).authorization === `Bearer ${valid}` ? fleet(url, init) : { status: 401 };
    });
    const adapter = new HttpAdapter(config(fetchStub, { auth: { kind: "client-credentials", tokenUrl: "http://fleet.test/token", clientId: "c", clientSecret: "s" } }));
    await adapter.resolveProperties("t.Aircraft", "A1", []);
    await adapter.resolveProperties("t.Aircraft", "A2", []);
    expect(issued).toBe(1);
    valid = "revoked";
    expect((await adapter.resolveProperties("t.Aircraft", "A3", [])).values).toMatchObject({ mds: "F-35A" });
    expect(issued).toBe(2);
    expect(calls.filter((c) => c.url.pathname === "/token")).toHaveLength(2);

    const { fetchStub: wrong } = stub(() => ({ status: 401 }));
    await expect(new HttpAdapter(config(wrong, { auth: { kind: "client-credentials", tokenUrl: "http://fleet.test/token", clientId: "c", clientSecret: "x" } })).resolveProperties("t.Aircraft", "A1", [])).rejects.toThrow(SourceRefusedError);
  });

  it("resolves a foreign-key relationship through the service's filter", async () => {
    const { fetchStub } = stub(fleet);
    const rel = { name: "same", targetType: "t.Aircraft", resolution: { dataSourceId: "fleet", operation: "byForeignKey:mds" } } as RelationshipDefinition;
    expect((await new HttpAdapter(config(fetchStub)).resolveRelationship(rel, "F-35A")).map((r) => r.objectId)).toEqual(["A3"]);
  });

  it("resolves an own-field relationship from the source object's mapped value, a missing value to nothing (ADR-0094)", async () => {
    const { fetchStub } = stub(fleet);
    const adapter = new HttpAdapter(config(fetchStub));
    const rel = { name: "variant", sourceType: "t.Aircraft", targetType: "t.Variant", resolution: { dataSourceId: "fleet", operation: "byOwnField:mds" } } as RelationshipDefinition;
    expect(await adapter.resolveRelationship(rel, "A3")).toEqual([{ objectId: "F-35A" }]);
    expect(await adapter.resolveRelationship(rel, "nope")).toEqual([]);
    const joined = { ...rel, resolution: { dataSourceId: "fleet", operation: "byJoinTable:j/a/b" } };
    await expect(adapter.resolveRelationship(joined, "A3")).rejects.toThrow(/byForeignKey and byOwnField/);
  });

  it("rejects a mapping that is not JSON Pointers, and reads pointers as RFC 6901 says", () => {
    const { fetchStub } = stub(fleet);
    expect(() => new HttpAdapter(config(fetchStub, { types: { t: { get: "/x/{id}", list: { path: "/x", items: "/i" }, id: "id", fields: {} } } }))).toThrow(/JSON Pointer/);
    expect(pointer({ "a/b": { "c~d": 1 } }, "/a~1b/c~0d")).toBe(1);
    expect(pointer({ a: 1 }, "")).toEqual({ a: 1 });
    expect(pointer({ a: 1 }, "/constructor")).toBeUndefined();
  });
});
