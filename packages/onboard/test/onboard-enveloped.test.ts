import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseline, buildDomain, fromOpenApi, sourceModel } from "../src/index.js";

/**
 * The recall exchange (examples/services/recall-exchange), a service
 * TypeSystem was not written for: every answer in a `{ data, meta }`
 * envelope, page-numbered lists, HTTP Basic, and a nullable response
 * declared as `oneOf` a reference and null. Before onboarding read these,
 * it proposed nothing for it.
 */
const doc = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../examples/services/recall-exchange/openapi.json"), "utf8")) as unknown;
const NOTICE = "openapi:rx#/components/schemas/Notice";

describe("onboarding an enveloped, page-numbered OpenAPI service", () => {
  const source = fromOpenApi(doc, { source: "rx" });

  it("keys an entity by the path its enveloped get names, and reads the envelope and the pages", () => {
    expect(source.entities.find((e) => e.id === NOTICE)?.key).toBe("recallNumber");
    const get = source.operations.find((o) => o.role === "get" && o.entity === NOTICE);
    expect(get).toMatchObject({ record: "/data" });
    const list = source.operations.find((o) => o.role === "list" && o.entity === NOTICE);
    expect(list).toMatchObject({ items: "/data", pages: { param: "page", more: "/meta/hasMore" } });
    expect(source.auth).toEqual({ kind: "basic" });
  });

  it("proposes the command on one notice, inlines a reference inside oneOf, and plans a Basic-auth adapter that pages", () => {
    const model = sourceModel([source]);
    const p = baseline(model, "coldchain");
    expect(p.types.map((t) => t.name)).toEqual(["coldchain.Notice"]);
    expect(p.actions).toHaveLength(1);
    const response = source.entities.find((e) => e.id === NOTICE)!.fields.find((f) => f.name === "response")!;
    expect(JSON.stringify(response.schema)).not.toContain("$ref");
    const built = buildDomain(model, p);
    const plan = built.adapters[0]!;
    expect(plan).toMatchObject({ kind: "http", auth: { kind: "basic", usernameEnv: "RX_CLIENT_ID", passwordEnv: "RX_CLIENT_SECRET" } });
    expect(plan.kind === "http" && plan.types["coldchain.Notice"]).toMatchObject({ record: "/data", list: { pages: { param: "page", more: "/meta/hasMore" } } });
  });
});
