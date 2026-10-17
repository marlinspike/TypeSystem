import { describe, expect, it } from "vitest";
import { HttpAdapter } from "../src/index.js";

/**
 * A service that wraps every answer in `{ data, meta }` and pages by number
 * (the recall exchange's shape): the record pointer unwraps a get, and
 * numbered pages are read until the service says there are no more.
 */
const ROWS = ["R1", "R2", "R3", "R4", "R5"].map((id, i) => ({ recallNumber: id, state: i % 2 ? "RECEIVED" : "PENDING" }));

function service() {
  const pages: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const one = /^\/notices\/(.+)$/.exec(url.pathname);
    if (one) {
      const r = ROWS.find((x) => x.recallNumber === decodeURIComponent(one[1]!));
      return r ? json(200, { data: r }) : json(404, { error: { code: "NOT_FOUND" } });
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    pages.push(String(page));
    return json(200, { data: ROWS.slice((page - 1) * 2, page * 2), meta: { page, hasMore: page * 2 < ROWS.length } });
  }) as typeof fetch;
  return { fetchStub, pages };
}

const adapterFor = (fetchStub: typeof fetch, maxPages?: number) =>
  new HttpAdapter({
    dataSourceId: "rx",
    system: "Recall exchange",
    baseUrl: "http://rx.test",
    fetch: fetchStub,
    ...(maxPages ? { maxPages } : {}),
    types: {
      "t.Recall": {
        get: "/notices/{id}",
        record: "/data",
        list: { path: "/notices", items: "/data", pages: { param: "page", more: "/meta/hasMore" } },
        id: "/recallNumber",
        fields: { responseStatus: { from: "/state", map: { PENDING: "awaiting", RECEIVED: "responded" } } }
      }
    }
  });

describe("HttpAdapter over an enveloped, page-numbered service", () => {
  it("reads one record out of its envelope, and a missing one as empty", async () => {
    const adapter = adapterFor(service().fetchStub);
    expect((await adapter.resolveProperties("t.Recall", "R2", [])).values).toEqual({ responseStatus: "responded" });
    expect(await adapter.resolveProperties("t.Recall", "R9", [])).toEqual({ values: {}, provenance: [] });
  });

  it("reads every numbered page until the service says there are no more", async () => {
    const { fetchStub, pages } = service();
    const all = await adapterFor(fetchStub).queryByType("t.Recall");
    expect(all.items.map((i) => i.objectId)).toEqual(["R1", "R2", "R3", "R4", "R5"]);
    expect(pages).toEqual(["1", "2", "3"]);
  });

  it("refuses to answer from a partial list rather than drop the pages past its limit", async () => {
    await expect(adapterFor(service().fetchStub, 2).queryByType("t.Recall")).rejects.toThrow(/more than 2 pages/);
  });

  it("refuses a mapping that pages both by cursor and by number", () => {
    expect(
      () =>
        new HttpAdapter({
          dataSourceId: "rx",
          system: "x",
          baseUrl: "http://rx.test",
          types: { "t.R": { get: "/r/{id}", list: { path: "/r", items: "", next: "/n", cursorParam: "c", pages: { param: "page", more: "/more" } }, id: "/id", fields: {} } }
        })
    ).toThrow(/cursor or by number/);
  });
});
