import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { InMemoryCache, type Cache } from "../src/runtime/cache.js";
import { DEMO_LINEAR_CLASSIFICATION } from "../src/runtime/classification.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { Identity } from "../src/model/policy.js";
import type { ProvenanceRef } from "../src/model/provenance.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * ADR-0036: the runtime never puts a sensitive value — of a marked Type or
 * member, marked in its provenance, in a field an adapter protects, or
 * computed from any of those — in a cache that isn't confidential. Every
 * policy allows and the reader is TOP_SECRET, so every value below is read;
 * the only question is where it may be kept.
 */
const DATA: Record<string, Record<string, Record<string, unknown>>> = {
  "test.Open": { o1: { id: "o1", name: "open-name" }, o2: { id: "o2", name: "linked" } },
  "test.Marked": { m1: { id: "m1", codeword: "KESTREL" } },
  "test.Mixed": { x1: { id: "x1", title: "mixed-title", body: "BODY-TEXT" } },
  "test.Protected": { p1: { id: "p1", ssn: "123-45-6789", label: "plain-label" } },
  "test.ValueMarked": { v1: { id: "v1", rating: "RATING-RESTRICTED" } },
  "test.Composite": { c1: { id: "c1", model: "C-17" } }
};
/** The warranty system, a second data source for `test.Composite.warranty` (ADR-0023), which protects it. */
const WARRANTY: Record<string, Record<string, unknown>> = { c1: { warranty: "WARRANTY-TERMS" } };
const SENSITIVE_PLAINTEXT = ["KESTREL", "BODY-TEXT", "123-45-6789", "RATING-RESTRICTED", "WARRANTY-TERMS"];

class SourceAdapter implements Adapter {
  reads = 0;
  constructor(
    readonly dataSourceId: string,
    private readonly data: Record<string, Record<string, Record<string, unknown>>>,
    private readonly protects: Record<string, readonly string[]> = {}
  ) {}
  private prov(type: string, id: string, values: Record<string, unknown>): ProvenanceRef[] {
    return Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: this.dataSourceId, system: this.dataSourceId, recordId: id, field },
      retrievedAt: "2026-01-01T00:00:00.000Z",
      // The source marks this one value itself.
      ...(type === "test.ValueMarked" && field === "rating" ? { classification: "SECRET" } : {})
    }));
  }
  async resolveProperties(type: string, id: string): Promise<ResolvedProperties> {
    this.reads++;
    const values = { ...(this.data[type]?.[id] ?? {}) };
    return { values, provenance: this.prov(type, id, values) };
  }
  async queryByType(type: string): Promise<AdapterQueryResult> {
    return { items: Object.entries(this.data[type] ?? {}).map(([objectId, v]) => ({ objectId, values: { ...v }, provenance: this.prov(type, objectId, v) })) };
  }
  async resolveRelationship(rel: RelationshipDefinition): Promise<RelatedRef[]> {
    return [{ objectId: rel.targetType === "test.Marked" ? "m1" : "o2" }];
  }
  async executeAction(): Promise<unknown> {
    return {};
  }
  sensitiveFields(typeName: string): readonly string[] {
    return this.protects[typeName] ?? [];
  }
}

/** A cache that records every key written, over a real one, with whatever `confidential` claim it's given. */
function spyCache(confidential: unknown) {
  const inner = new InMemoryCache();
  const written = new Map<string, unknown>();
  const cache = {
    confidential,
    get: <T>(key: string) => inner.get<T>(key),
    set: async <T>(key: string, value: T, ttl: number) => {
      written.set(key, value);
      await inner.set(key, value, ttl);
    },
    delete: (key: string) => inner.delete(key),
    clear: () => inner.clear()
  } as unknown as Cache;
  return { cache, written };
}

const cached = { resolutionMode: "cached" as const, cacheTtlMs: 60_000 };
const rel = (target: string) => ({ target, cardinality: "one-to-many" as const, resolution: { dataSourceId: "ds", operation: "byForeignKey:parentId" }, ...cached });
const strings = (names: string[]) => Object.fromEntries(names.map((n) => [n, { type: "string" }]));

/** A method-proxying decorator, like a call counter: every method it forwards comes back async. */
function proxied<A extends Adapter>(adapter: A): A {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? async (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args) : value;
    }
  });
}

async function setup(cache: Cache, wrap: (ds: SourceAdapter) => Adapter = (ds) => ds) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const register = async (name: string, schema: Omit<SemanticTypeSchema, "$id" | "type" | "title">, computed: Record<string, (get: (p: string) => Promise<unknown>) => Promise<unknown>> = {}) => {
    const short = name.split(".")[1]!;
    await registry.registerType(
      { $id: `https://typesys.dev/types/test/${short}/1.0.0`, type: "object", title: short, "x-policy": { objectPolicy: "public" }, ...schema },
      { name, version: "1.0.0", computedImplementations: Object.fromEntries(Object.entries(computed).map(([k, f]) => [k, (ctx) => f((p) => ctx.getProperty(p))])) }
    );
    await registry.registerMapping({ id: `map-${short}`, typeName: name, target: "property", targetName: "*", dataSourceId: "ds", operation: "get", ...cached });
  };
  const upper = (dep: string) => async (get: (p: string) => Promise<unknown>) => String(await get(dep)).toUpperCase();
  const derived = (deps: Record<string, string>) => Object.fromEntries(Object.entries(deps).map(([name, dep]) => [name, { dependsOn: [dep], binding: name, ...cached }]));

  await register("test.Open", { properties: strings(["id", "name"]), "x-computed": derived({ shout: "name" }), "x-relationships": { links: rel("test.Open") } }, { shout: upper("name") });
  await register(
    "test.Marked",
    { properties: strings(["id", "codeword"]), "x-computed": derived({ hint: "codeword" }), "x-relationships": { peers: rel("test.Open") }, "x-provenance": { defaultClassification: "SECRET" } },
    { hint: upper("codeword") }
  );
  await register(
    "test.Mixed",
    {
      properties: strings(["id", "title", "body"]),
      "x-computed": derived({ gistOfBody: "body", twiceGist: "gistOfBody", titleUpper: "title" }),
      "x-relationships": { plainLinks: rel("test.Open"), secretLinks: rel("test.Open"), toMarked: rel("test.Marked") },
      "x-provenance": { properties: { body: { classification: "CUI" }, secretLinks: { classification: "SECRET" } } }
    },
    { gistOfBody: upper("body"), twiceGist: upper("gistOfBody"), titleUpper: upper("title") }
  );
  await register("test.Protected", { properties: strings(["id", "ssn", "label"]), "x-computed": derived({ last4: "ssn", labelLen: "label" }) }, { last4: upper("ssn"), labelLen: upper("label") });
  await register("test.ValueMarked", { properties: strings(["id", "rating"]), "x-computed": derived({ ratingEcho: "rating", idEcho: "id" }) }, { ratingEcho: upper("rating"), idEcho: upper("id") });
  await register("test.Composite", { properties: strings(["id", "model", "warranty"]) });
  await registry.registerMapping({ id: "map-warranty", typeName: "test.Composite", target: "property", targetName: "warranty", dataSourceId: "warranty", operation: "get", ...cached });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  const ds = new SourceAdapter("ds", DATA, { "test.Protected": ["ssn"] });
  const warranty = new SourceAdapter("warranty", { "test.Composite": WARRANTY }, { "test.Composite": ["warranty"] });
  const runtime = new SemanticRuntime(registry, [wrap(ds), warranty], policyEngine, { cache, classification: DEMO_LINEAR_CLASSIFICATION });
  return { runtime, ds, warranty };
}

const reader: Identity = { subjectId: "ts", roles: [], attributes: {}, clearance: "TOP_SECRET" };

/** Every cached-mode read path, over every Type: objects, relationships, and queries. */
async function readEverything(runtime: SemanticRuntime) {
  const read: Record<string, Record<string, unknown>> = {};
  for (const [type, id] of [["test.Open", "o1"], ["test.Marked", "m1"], ["test.Mixed", "x1"], ["test.Protected", "p1"], ["test.ValueMarked", "v1"], ["test.Composite", "c1"]] as const) {
    read[type] = (await runtime.getObject(type, id, reader)).values;
  }
  await runtime.getRelationship("test.Open", "o1", "links", reader);
  await runtime.getRelationship("test.Marked", "m1", "peers", reader);
  for (const r of ["plainLinks", "secretLinks", "toMarked"]) await runtime.getRelationship("test.Mixed", "x1", r, reader);
  for (const type of ["test.Protected", "test.Mixed", "test.ValueMarked"]) await runtime.query({ type }, reader);
  return read;
}

/** What a non-confidential cache may hold after every read path ran: only what nothing sensitive went into. */
const NON_CONFIDENTIAL_KEYS = [
  "computed:test.Mixed:x1:titleUpper",
  "computed:test.Open:o1:shout",
  "computed:test.Open:o2:shout",
  "computed:test.Protected:p1:labelLen",
  "computed:test.ValueMarked:v1:idEcho",
  "prop:ds:test.Composite:c1",
  "prop:ds:test.Open:o1",
  "prop:ds:test.Open:o2",
  "rel:ds:links:o1",
  "rel:ds:plainLinks:x1"
];

describe("sensitive-data caching (ADR-0036)", () => {
  describe("attack: sensitive values never reach a cache that isn't confidential", () => {
    it("after every read path, the cache holds exactly the non-sensitive entries and none of the sensitive plaintext", async () => {
      const { cache, written } = spyCache(false);
      const { runtime } = await setup(cache);
      const first = await readEverything(runtime);
      await readEverything(runtime);

      expect([...written.keys()].sort()).toEqual(NON_CONFIDENTIAL_KEYS);
      const stored = JSON.stringify([...written.values()]);
      for (const secret of SENSITIVE_PLAINTEXT) expect(stored).not.toContain(secret);
      // And the reads themselves are unaffected: every value, sensitive or not, came back.
      expect(first["test.Marked"]).toMatchObject({ codeword: "KESTREL", hint: "KESTREL" });
      expect(first["test.Mixed"]).toMatchObject({ body: "BODY-TEXT", gistOfBody: "BODY-TEXT", twiceGist: "BODY-TEXT", titleUpper: "MIXED-TITLE" });
      expect(first["test.Protected"]).toMatchObject({ ssn: "123-45-6789", last4: "123-45-6789", labelLen: "PLAIN-LABEL" });
      expect(first["test.ValueMarked"]).toMatchObject({ rating: "RATING-RESTRICTED", ratingEcho: "RATING-RESTRICTED", idEcho: "V1" });
      expect(first["test.Composite"]).toMatchObject({ model: "C-17", warranty: "WARRANTY-TERMS" });
    });

    it("a sensitive bundle is read live every time; a non-sensitive one is served from the cache", async () => {
      const { cache } = spyCache(false);
      const { runtime, ds, warranty } = await setup(cache);
      for (let i = 0; i < 3; i++) await runtime.getObject("test.Protected", "p1", reader);
      expect(ds.reads).toBe(3);
      ds.reads = 0;
      for (let i = 0; i < 3; i++) await runtime.getObject("test.Composite", "c1", reader);
      // The base bundle caches; the override from the system that protects `warranty` doesn't.
      expect(ds.reads).toBe(1);
      expect(warranty.reads).toBe(3);
    });

    for (const [label, claim] of [
      ["omits the flag", undefined],
      ["says \"true\" as a string", "true"],
      ["says 1", 1]
    ] as const) {
      it(`a cache that ${label} is treated as not confidential`, async () => {
        const { cache, written } = spyCache(claim);
        const { runtime } = await setup(cache);
        await readEverything(runtime);
        expect([...written.keys()].sort()).toEqual(NON_CONFIDENTIAL_KEYS);
      });
    }
  });

  describe("attack: a decorator that mangles the declaration", () => {
    it("a proxy that makes sensitiveFields async still protects exactly the declared fields", async () => {
      const { cache, written } = spyCache(false);
      const { runtime } = await setup(cache, proxied);
      await readEverything(runtime);
      expect([...written.keys()].sort()).toEqual(NON_CONFIDENTIAL_KEYS);
    });

    for (const [label, answer] of [
      ["answers something other than a list of names", () => "ssn"],
      ["answers a list with a non-name in it", () => ["ssn", 7]],
      ["throws", () => {
        throw new Error("lookup failed");
      }]
    ] as const) {
      it(`one that ${label} protects every field of that adapter: fail closed`, async () => {
        const { cache, written } = spyCache(false);
        const { runtime } = await setup(cache, (ds) => Object.assign(ds, { sensitiveFields: answer as unknown as SourceAdapter["sensitiveFields"] }));
        await readEverything(runtime);
        // Nothing from that adapter's bundles or anything computed on them; relationship ref lists carry no field values.
        expect([...written.keys()].sort()).toEqual(["rel:ds:links:o1", "rel:ds:plainLinks:x1"]);
        const stored = JSON.stringify([...written.values()]);
        for (const secret of SENSITIVE_PLAINTEXT) expect(stored).not.toContain(secret);
      });
    }
  });

  describe("a confidential cache", () => {
    it("holds everything, sensitive or not, exactly as before", async () => {
      const { cache, written } = spyCache(true);
      const { runtime, ds, warranty } = await setup(cache);
      await readEverything(runtime);
      expect([...written.keys()]).toEqual(expect.arrayContaining([
        "prop:ds:test.Marked:m1",
        "prop:ds:test.Mixed:x1",
        "prop:ds:test.Protected:p1",
        "prop:ds:test.ValueMarked:v1",
        "prop:warranty:test.Composite:c1",
        "computed:test.Mixed:x1:twiceGist",
        "computed:test.Protected:p1:last4",
        "computed:test.ValueMarked:v1:ratingEcho",
        "rel:ds:peers:m1",
        "rel:ds:secretLinks:x1",
        "rel:ds:toMarked:x1"
      ]));
      ds.reads = 0;
      warranty.reads = 0;
      await readEverything(runtime);
      expect(ds.reads + warranty.reads).toBe(0);
    });

    it("InMemoryCache is confidential: sensitive bundles are served from it", async () => {
      const { runtime, ds } = await setup(new InMemoryCache());
      for (let i = 0; i < 3; i++) await runtime.getObject("test.Protected", "p1", reader);
      expect(ds.reads).toBe(1);
    });
  });
});
