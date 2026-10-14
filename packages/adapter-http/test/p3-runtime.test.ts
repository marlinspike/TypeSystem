import { describe, expect, it } from "vitest";
import { AbacPolicyEngine, InMemoryRegistryStore, SemanticRegistry, SemanticRuntime, allowAllRule, type ComputeContext, type Identity } from "@typesys/core";
import { HttpAdapter } from "../src/index.js";

/**
 * Pressure test 3 (P3): the HTTP adapter under the runtime's deadline
 * (ADR-0026, ADR-0072). Fails on the reviewed head (identical to PR #14).
 */
const RECORDS = [
  { tail_no: "A1", mds: "F-16C" },
  { tail_no: "A2", mds: "F-16C" },
  { tail_no: "A3", mds: "F-35A" }
];
const ANY: Identity = { subjectId: "u", roles: [], attributes: {} };

const fetchStub = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname.startsWith("/a/")) {
    const r = RECORDS.find((x) => x.tail_no === decodeURIComponent(url.pathname.slice(3)));
    return new Response(JSON.stringify(r ?? {}), { status: r ? 200 : 404 });
  }
  const mds = url.searchParams.get("mds");
  return new Response(JSON.stringify({ data: RECORDS.filter((r) => mds === null || r.mds === mds) }), { status: 200 });
}) as typeof fetch;

async function runtimeWith(resilience: { callTimeoutMs?: number }) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/t/Aircraft/1.0.0",
      title: "Aircraft",
      type: "object",
      properties: { mds: { type: "string" } },
      "x-computed": { sameMds: { dependsOn: ["mds"], binding: "sameMds" } },
      "x-policy": { objectPolicy: "open" }
    },
    {
      name: "t.Aircraft",
      version: "1.0.0",
      computedImplementations: {
        // How many airframes share this one's MDS: a lookup through the adapter, as a computation makes one.
        sameMds: async (ctx: ComputeContext) => (await ctx.getAdapter("fleet").queryByType("t.Aircraft", { property: "mds", operator: "eq", value: await ctx.getProperty("mds") })).items.length
      }
    }
  );
  await registry.registerMapping({ id: "m", typeName: "t.Aircraft", target: "property", targetName: "*", dataSourceId: "fleet", operation: "get", resolutionMode: "live" });
  const adapter = new HttpAdapter({
    dataSourceId: "fleet",
    system: "Fleet",
    baseUrl: "http://fleet.test",
    fetch: fetchStub,
    types: { "t.Aircraft": { get: "/a/{id}", list: { path: "/a", items: "/data", params: { mds: "mds" } }, id: "/tail_no", fields: { mds: "/mds" } } }
  });
  const policy = new AbacPolicyEngine();
  policy.registerRule("open", allowAllRule);
  return new SemanticRuntime(registry, [adapter], policy, { resilience });
}

describe("P3 HttpAdapter under a deadline", () => {
  it("P3-H10: a computation's queryByType(type, filter) answers the same with a callTimeoutMs as without one", async () => {
    const plain = await (await runtimeWith({})).getObject("t.Aircraft", "A1", ANY);
    expect(plain.values.sameMds).toBe(2);
    const bounded = await (await runtimeWith({ callTimeoutMs: 1_000 })).getObject("t.Aircraft", "A1", ANY);
    // Today 0: the runtime appends { signal } after the two arguments given, so the adapter reads it as `limit`
    // (runtime.ts getAdapter), and HttpAdapter slices its answer to slice(0, "0[object Object]"): nothing.
    expect(bounded.values.sameMds).toBe(2);
  });
});
