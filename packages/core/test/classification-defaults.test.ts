import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime, type SemanticRuntimeOptions } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { DEMO_LINEAR_CLASSIFICATION, DENY_MARKED_DATA, type ClassificationScheme } from "../src/runtime/classification.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";
import type { ProvenanceRef } from "../src/model/provenance.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * ADR-0034: the runtime's default classification scheme is the explicit
 * `DENY_MARKED_DATA` — unmarked data reads as before, marked data is denied
 * whatever the clearance — so classification can't be switched off by
 * forgetting to configure it. Every policy here allows everyone, so every
 * denial below is classification's.
 */
const DATA: Record<string, Record<string, Record<string, unknown>>> = {
  "test.Dossier": { d1: { id: "d1", title: "Harbor", codeword: "KESTREL" } },
  "test.Memo": {
    m1: { id: "m1", subject: "Lunch", body: "Tuesday", rating: "restricted-note" },
    m2: { id: "m2", subject: "Budget", body: "Q4", rating: "plain" }
  },
  "test.Plain": { p1: { id: "p1", name: "Nothing to hide" } }
};
/** The adapter marks one stored value itself, in its provenance. */
const VALUE_MARKINGS: Record<string, string> = { "test.Memo/m1/rating": "SECRET" };

class MarkingAdapter implements Adapter {
  readonly dataSourceId = "ds";
  private prov(type: string, id: string, values: Record<string, unknown>): ProvenanceRef[] {
    return Object.keys(values).map((field) => {
      const classification = VALUE_MARKINGS[`${type}/${id}/${field}`];
      return { propertyPath: field, source: { dataSourceId: "ds", system: "ds", recordId: id, field }, retrievedAt: "2026-01-01T00:00:00.000Z", ...(classification ? { classification } : {}) };
    });
  }
  async resolveProperties(type: string, id: string): Promise<ResolvedProperties> {
    const values = DATA[type]?.[id] ?? {};
    return { values: { ...values }, provenance: this.prov(type, id, values) };
  }
  async queryByType(type: string, filter?: QueryFilter): Promise<AdapterQueryResult> {
    return {
      items: Object.entries(DATA[type] ?? {})
        .filter(([, v]) => matchesFilter(v, filter))
        .map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: this.prov(type, objectId, values) }))
    };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    return { ok: true };
  }
}

async function setup(options?: SemanticRuntimeOptions) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const register = async (name: string, schema: Omit<SemanticTypeSchema, "$id" | "type" | "title">) => {
    const short = name.split(".")[1]!;
    await registry.registerType({ $id: `https://typesys.dev/types/test/${short}/1.0.0`, type: "object", title: short, ...schema }, {
      name,
      version: "1.0.0",
      computedImplementations: { gist: async (ctx) => String(await ctx.getProperty("body")).slice(0, 2) }
    });
    await registry.registerMapping({ id: `map-${short}`, typeName: name, target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  };
  const strings = (names: string[]) => Object.fromEntries(names.map((n) => [n, { type: "string" }]));
  await register("test.Dossier", { properties: strings(["id", "title", "codeword"]), "x-policy": { objectPolicy: "public" }, "x-provenance": { defaultClassification: "SECRET" } });
  await register("test.Memo", {
    properties: strings(["id", "subject", "body", "rating"]),
    "x-computed": { gist: { dependsOn: ["body"], binding: "gist" } },
    "x-policy": { objectPolicy: "public" },
    "x-provenance": { properties: { body: { classification: "CUI" } } }
  });
  await register("test.Plain", { properties: strings(["id", "name"]), "x-policy": { objectPolicy: "public" } });
  await registry.registerAction({
    id: "action-annotate",
    name: "AnnotateDossier",
    description: "Annotates a dossier.",
    applicableTypes: ["test.Dossier"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    authorizationPolicy: "public",
    implementation: { dataSourceId: "ds", operation: "annotate" },
    sideEffects: "mutates",
    idempotency: "none",
    auditRequired: false,
    version: "1.0.0"
  });
  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  return { runtime: new SemanticRuntime(registry, [new MarkingAdapter()], policyEngine, options), registry };
}

const topSecret: Identity = { subjectId: "ts", roles: [], attributes: {}, clearance: "TOP_SECRET" };
const uncleared: Identity = { subjectId: "u", roles: [], attributes: {} };
const keys = (o: { values: Record<string, unknown> }) => Object.keys(o.values).sort();

describe("classification defaults (ADR-0034)", () => {
  describe("DENY_MARKED_DATA", () => {
    it("dominates nothing: no clearance, however high or strange, reads any marking", () => {
      const clearances = [undefined, "", "UNCLASSIFIED", "TOP_SECRET", "SECRET//NOFORN", "*", "__proto__"];
      const markings = ["UNCLASSIFIED", "CUI", "SECRET", "TOP_SECRET", "", "*", "constructor"];
      for (const c of clearances) for (const m of markings) expect(DENY_MARKED_DATA.dominates(c, m)).toBe(false);
    });

    it("is a named, frozen object — not a meaning attached to an absent option", () => {
      expect(DENY_MARKED_DATA.name).toBe("deny-marked-data");
      expect(Object.isFrozen(DENY_MARKED_DATA)).toBe(true);
      expect(() => ((DENY_MARKED_DATA as { dominates: unknown }).dominates = () => true)).toThrow(TypeError);
    });
  });

  describe("attack: classification can't be switched off by leaving it unconfigured", () => {
    for (const [label, options] of [
      ["no options at all", undefined],
      ["an empty options object", {}],
      ["classification: undefined", { classification: undefined }],
      ["classification: null", { classification: null as unknown as ClassificationScheme }]
    ] as const) {
      it(`${label}: marked data is unreadable even to TOP_SECRET, and unmarked data reads as before`, async () => {
        const { runtime } = await setup(options);
        // Marked object: refused before any read.
        await expect(runtime.getObject("test.Dossier", "d1", topSecret)).rejects.toBeInstanceOf(AuthorizationError);
        expect((await runtime.query({ type: "test.Dossier" }, topSecret)).items).toEqual([]);
        await expect(runtime.aggregate({ type: "test.Dossier", aggregations: [{ name: "n", op: "count" }] }, topSecret)).rejects.toBeInstanceOf(AuthorizationError);
        // Marked member, marked value, and what derives from them: redacted.
        const memo = await runtime.getObject("test.Memo", "m1", topSecret);
        expect(keys(memo)).toEqual(["id", "subject"]); // body (CUI), gist (from body), rating (SECRET by provenance)
        await expect(runtime.query({ type: "test.Memo", filter: { property: "body", operator: "eq", value: "Q4" } }, topSecret)).rejects.toBeInstanceOf(AuthorizationError);
        await expect(runtime.getProvenance("test.Memo", "m1", "rating", topSecret)).rejects.toBeInstanceOf(AuthorizationError);
        // Actions on a marked Type: refused, and listed as unauthorized.
        await expect(runtime.invokeAction("AnnotateDossier", {}, topSecret)).rejects.toBeInstanceOf(AuthorizationError);
        expect((await runtime.listActions("test.Dossier", topSecret)).map((a) => a.authorized)).toEqual([false]);
        // Unmarked data is untouched by the default, for everyone.
        expect((await runtime.getObject("test.Plain", "p1", uncleared)).values).toEqual({ id: "p1", name: "Nothing to hide" });
        expect(keys(await runtime.getObject("test.Memo", "m2", uncleared))).toEqual(["id", "rating", "subject"]); // m2's rating carries no marking
      });
    }

    it("an unusable scheme object denies too, rather than failing open", async () => {
      const { runtime } = await setup({ classification: { name: "broken" } as unknown as ClassificationScheme });
      await expect(runtime.getObject("test.Dossier", "d1", topSecret)).rejects.toBeInstanceOf(AuthorizationError);
      expect((await runtime.getObject("test.Plain", "p1", uncleared)).values.name).toBe("Nothing to hide");
    });

    it("only a configured scheme that dominates the marking opens it", async () => {
      const { runtime } = await setup({ classification: DEMO_LINEAR_CLASSIFICATION });
      expect((await runtime.getObject("test.Dossier", "d1", topSecret)).values.codeword).toBe("KESTREL");
      expect(keys(await runtime.getObject("test.Memo", "m1", topSecret))).toEqual(["body", "gist", "id", "rating", "subject"]);
      await expect(runtime.getObject("test.Dossier", "d1", uncleared)).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("audit", () => {
    it("every classification row names the scheme that decided, so 'no scheme configured' is visible", async () => {
      const unconfigured = await setup();
      await unconfigured.runtime.getObject("test.Dossier", "d1", topSecret).catch(() => undefined);
      const [row] = (await unconfigured.registry.listAuditEvents({ limit: 10 })).items.filter((e) => e.details?.control === "classification");
      expect(row).toMatchObject({ decision: "deny", reason: "Requires a higher clearance", details: { scheme: "deny-marked-data", markings: ["SECRET"], clearance: "TOP_SECRET" } });

      const configured = await setup({ classification: DEMO_LINEAR_CLASSIFICATION });
      await configured.runtime.getObject("test.Dossier", "d1", topSecret);
      const [allowed] = (await configured.registry.listAuditEvents({ limit: 10 })).items.filter((e) => e.details?.control === "classification");
      expect(allowed).toMatchObject({ decision: "allow", details: { scheme: "demo-linear" } });
    });

    it("unmarked data never asks the scheme and writes no classification row", async () => {
      const asked: string[] = [];
      const spy: ClassificationScheme = { name: "spy", dominates: (_c, m) => (asked.push(m), true) };
      const { runtime, registry } = await setup({ classification: spy });
      await runtime.getObject("test.Plain", "p1", uncleared);
      expect(asked).toEqual([]);
      await runtime.getObject("test.Memo", "m2", uncleared); // m2: the declared body marking, and gist derived from it
      expect(asked).toEqual(["CUI", "CUI"]);
      const rows = (await registry.listAuditEvents({ limit: 50 })).items.filter((e) => e.details?.control === "classification");
      expect(rows.map((e) => `${e.resource.typeName}/${e.resource.objectId}.${e.resource.propertyPath}`).sort()).toEqual(["test.Memo/m2.body", "test.Memo/m2.gist"]);
    });
  });
});
