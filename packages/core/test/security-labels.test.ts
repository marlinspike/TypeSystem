import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { securityLabels, type ClassificationRequest, type ClassificationScheme } from "../src/runtime/classification.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";

/**
 * ADR-0041: classification schemes decide whole labels for whole subjects,
 * and join the labels of derived data. The runtime decides the join and every
 * marking on its own, so a join can only add restriction. `securityLabels` is
 * a demonstration of the model — levels, compartments, releasability, CUI as
 * its own regime, and the system's accreditation — not the CAPCO register.
 */
const LEVELS = ["UNCLASSIFIED", "CONFIDENTIAL", "SECRET", "TOP_SECRET"];
const labels = securityLabels({ levels: LEVELS, homeCountry: "USA" });
const who = (clearance: string | undefined, attributes: Record<string, unknown> = {}): Identity => ({
  subjectId: `s-${clearance}-${JSON.stringify(attributes)}`,
  roles: [],
  attributes,
  ...(clearance === undefined ? {} : { clearance })
});
const CONTEXT = { action: "read" as const, resource: { typeName: "T" } };
const decide = (scheme: ClassificationScheme, subject: Identity, markings: string[]) => scheme.decide({ subject, markings, context: CONTEXT });

describe("securityLabels (ADR-0041)", () => {
  it("refuses a malformed configuration", () => {
    expect(() => securityLabels({ levels: [], homeCountry: "USA" })).toThrow(TypeError);
    expect(() => securityLabels({ levels: ["LOW", "LOW"], homeCountry: "USA" })).toThrow(TypeError);
    expect(() => securityLabels({ levels: ["LOW", "CUI"], homeCountry: "USA" })).toThrow(TypeError);
    expect(() => securityLabels({ levels: LEVELS, homeCountry: "US" })).toThrow(TypeError);
    expect(() => securityLabels({ levels: LEVELS, homeCountry: "USA", accreditation: { level: "COSMIC", cui: true } })).toThrow(TypeError);
  });

  it("attack: a marking it can't parse is refused, for everyone", () => {
    const everything = who("TOP_SECRET", { compartments: ["ALPHA"], citizenship: "USA", cuiCategories: ["PRVCY"] });
    for (const marking of ["secret", "SECRET ", "COSMIC", "SECRET//", "SECRET//alpha", "SECRET//REL TO US", "SECRET//REL TO USA,GBR", "SECRET//NOFORN//ALPHA", "SECRET//ALPHA/NOFORN", "SECRET//A//B//NOFORN", "CUI//", "CUI//NOFORN", "CUI//A//B", "CUI SECRET", "", "SECRET//REL TO NO ONE", "__proto__"]) {
      const decision = decide(labels, everything, [marking]);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe(`unrecognized marking ${marking}`);
    }
  });

  it("decides each dimension: level, compartments, releasability, CUI, accreditation", () => {
    const full = { compartments: ["ALPHA", "BRAVO"], citizenship: "USA", cuiCategories: ["PRVCY", "LEI"] };
    expect(decide(labels, who("SECRET", full), ["SECRET//ALPHA/BRAVO//REL TO USA, GBR"]).allow).toBe(true);
    expect(decide(labels, who("CONFIDENTIAL", full), ["SECRET"])).toEqual({ allow: false, reason: "clearance below SECRET" });
    expect(decide(labels, who("SECRET", { ...full, compartments: ["ALPHA"] }), ["SECRET//ALPHA/BRAVO"])).toEqual({ allow: false, reason: "not read into BRAVO" });
    expect(decide(labels, who("SECRET", { ...full, citizenship: "GBR" }), ["SECRET//REL TO USA, GBR"]).allow).toBe(true);
    expect(decide(labels, who("SECRET", { ...full, citizenship: "GBR" }), ["SECRET//NOFORN"])).toEqual({ allow: false, reason: "not releasable to this subject" });
    expect(decide(labels, who("SECRET", { ...full, citizenship: "CAN" }), ["SECRET//REL TO USA, GBR"]).allow).toBe(false);
    // CUI is its own regime: no clearance reaches it, and it needs no clearance.
    expect(decide(labels, who("TOP_SECRET"), ["CUI//PRVCY"])).toEqual({ allow: false, reason: "not authorized for CUI" });
    expect(decide(labels, who(undefined, { cuiCategories: ["PRVCY"] }), ["CUI//PRVCY"]).allow).toBe(true);
    expect(decide(labels, who(undefined, { cuiCategories: ["PRVCY"] }), ["CUI//PRVCY/LEI"])).toEqual({ allow: false, reason: "not authorized for CUI//LEI" });
    expect(decide(labels, who(undefined, { cuiCategories: [] }), ["CUI"]).allow).toBe(true);
    // The system's own accreditation bounds what anyone may read here.
    const secretSystem = securityLabels({ levels: LEVELS, homeCountry: "USA", accreditation: { level: "SECRET", cui: false } });
    expect(decide(secretSystem, who("TOP_SECRET"), ["TOP_SECRET"])).toEqual({ allow: false, reason: "the system is not accredited for TOP_SECRET" });
    expect(decide(secretSystem, who(undefined, { cuiCategories: [] }), ["CUI"])).toEqual({ allow: false, reason: "the system is not accredited for CUI" });
  });

  it("attack: a subject attribute of the wrong shape grants nothing", () => {
    for (const attributes of [{ compartments: "ALPHA" }, { compartments: [["ALPHA"]] }, { compartments: { 0: "ALPHA" } }]) {
      expect(decide(labels, who("SECRET", attributes), ["SECRET//ALPHA"]).allow).toBe(false);
    }
    for (const citizenship of [["USA"], { toString: () => "USA" }, undefined, 840]) {
      expect(decide(labels, who("SECRET", { citizenship }), ["SECRET//NOFORN"]).allow).toBe(false);
    }
    for (const cuiCategories of ["PRVCY", [["PRVCY"]], null]) expect(decide(labels, who(undefined, { cuiCategories }), ["CUI//PRVCY"]).allow).toBe(false);
    expect(decide(labels, who(undefined), ["UNCLASSIFIED"]).allow).toBe(false); // no clearance at all holds no level
  });

  it("joins a derived label: highest level, compartments and CUI categories unioned, releasability intersected", () => {
    // Released to the home country alone is written NOFORN.
    expect(labels.join(["SECRET//ALPHA//REL TO USA, GBR", "TOP_SECRET//BRAVO//REL TO USA, CAN"])).toEqual(["TOP_SECRET//ALPHA/BRAVO//NOFORN"]);
    expect(labels.join(["SECRET//REL TO USA, GBR", "SECRET//REL TO GBR, USA, CAN"])).toEqual(["SECRET//REL TO GBR, USA"]);
    expect(labels.join(["SECRET//REL TO GBR, USA", "CONFIDENTIAL//NOFORN"])).toEqual(["SECRET//NOFORN"]);
    expect(labels.join(["CUI//PRVCY", "SECRET", "CUI//LEI"])).toEqual(["SECRET", "CUI//LEI/PRVCY"]);
    expect(labels.join(["Secret", "SECRET", "COSMIC"])).toEqual(["SECRET", "COSMIC", "Secret"]); // what it can't parse, it keeps — to be refused
    // Released to GBR only, and to CAN only: released to no one, and refused for everyone.
    const nobody = labels.join(["SECRET//REL TO GBR", "SECRET//REL TO CAN"]);
    for (const citizenship of ["GBR", "CAN", "USA"]) expect(decide(labels, who("TOP_SECRET", { citizenship }), [...nobody]).allow).toBe(false);
  });

  describe("properties, over generated markings and subjects", () => {
    function rng(seed: number) {
      let s = seed >>> 0;
      return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    }
    const pick = <T>(next: () => number, xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
    const some = <T>(next: () => number, xs: readonly T[]) => xs.filter(() => next() < 0.4);
    function marking(next: () => number): string {
      if (next() < 0.2) {
        const cats = some(next, ["LEI", "PRVCY", "EXPT"]);
        return `CUI${cats.length ? `//${cats.join("/")}` : ""}`;
      }
      const comps = some(next, ["ALPHA", "BRAVO"]);
      const r = next();
      const release = r < 0.5 ? "" : r < 0.7 ? "//NOFORN" : `//REL TO ${["USA", ...some(next, ["CAN", "GBR"])].join(", ")}`;
      return `${pick(next, LEVELS)}${comps.length ? `//${comps.join("/")}` : ""}${release}`;
    }
    function subject(next: () => number): Identity {
      return who(next() < 0.9 ? pick(next, LEVELS) : undefined, {
        compartments: some(next, ["ALPHA", "BRAVO"]),
        citizenship: pick(next, ["USA", "CAN", "GBR"]),
        ...(next() < 0.7 ? { cuiCategories: some(next, ["LEI", "PRVCY", "EXPT"]) } : {})
      });
    }

    it("join is idempotent and order-blind, and decides exactly as the markings do together and one by one", () => {
      const next = rng(41);
      for (let i = 0; i < 3000; i++) {
        const ms = Array.from({ length: 1 + Math.floor(next() * 4) }, () => marking(next));
        const joined = labels.join(ms);
        expect(labels.join(joined)).toEqual(joined);
        expect(labels.join([...ms].reverse())).toEqual(joined);
        const s = subject(next);
        const onJoin = decide(labels, s, [...joined]).allow;
        expect(onJoin).toBe(decide(labels, s, ms).allow);
        // No compilation rule in this scheme: the join is exactly the conjunction of its parts.
        expect(onJoin).toBe(ms.every((m) => decide(labels, s, [m]).allow));
      }
    });
  });
});

describe("the runtime decides joined labels (ADR-0041)", () => {
  const MARKED: Record<string, string> = {
    ukShared: "SECRET//ALPHA//REL TO USA, GBR",
    caShared: "SECRET//BRAVO//REL TO USA, CAN",
    privacy: "CUI//PRVCY",
    crown: "TOP_SECRET"
  };
  const VALUES = { id: "d1", ukShared: "UK-SHARED-FACT", caShared: "CA-SHARED-FACT", privacy: "PRIVATE-FACT", crown: "CROWN-FACT", plain: "PLAIN" };
  class Adapter1 implements Adapter {
    readonly dataSourceId = "ds";
    async resolveProperties(): Promise<ResolvedProperties> {
      return { values: { ...VALUES }, provenance: [] };
    }
    async queryByType(_t: string, filter?: QueryFilter): Promise<AdapterQueryResult> {
      return { items: matchesFilter(VALUES, filter) ? [{ objectId: "d1", values: { ...VALUES }, provenance: [] }] : [] };
    }
    async resolveRelationship() {
      return [];
    }
    async executeAction() {
      return { ok: true };
    }
  }
  async function setup(scheme: ClassificationScheme) {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registry.registerType(
      {
        $id: "https://typesys.dev/types/test/Dossier/1.0.0",
        type: "object",
        title: "Dossier",
        properties: Object.fromEntries(Object.keys(VALUES).map((p) => [p, { type: "string" }])),
        "x-computed": { fused: { dependsOn: ["ukShared", "caShared"], binding: "fused" } },
        "x-policy": { objectPolicy: "public" },
        "x-provenance": { properties: Object.fromEntries(Object.entries(MARKED).map(([p, classification]) => [p, { classification }])) }
      },
      { name: "test.Dossier", version: "1.0.0", computedImplementations: { fused: async (ctx) => `${String(await ctx.getProperty("ukShared"))}+${String(await ctx.getProperty("caShared"))}` } }
    );
    await registry.registerMapping({ id: "m", typeName: "test.Dossier", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
    const engine = new AbacPolicyEngine();
    engine.registerRule("public", allowAllRule);
    return { runtime: new SemanticRuntime(registry, [new Adapter1()], engine, { classification: scheme }), registry };
  }
  const read = async (runtime: SemanticRuntime, subject: Identity) => Object.keys((await runtime.getObject("test.Dossier", "d1", subject)).values).sort();

  it("a derived value carries the join of its inputs: readable only where every input's restrictions allow", async () => {
    const { runtime, registry } = await setup(labels);
    const american = who("SECRET", { compartments: ["ALPHA", "BRAVO"], citizenship: "USA" });
    const briton = who("SECRET", { compartments: ["ALPHA", "BRAVO"], citizenship: "GBR" });
    expect(await read(runtime, american)).toEqual(["caShared", "fused", "id", "plain", "ukShared"]);
    expect(await read(runtime, briton)).toEqual(["id", "plain", "ukShared"]); // not CA-shared data, nor what fuses it
    const fused = (await registry.listAuditEvents({ limit: 100 })).items.find((e) => e.resource.propertyPath === "fused" && e.subjectId === briton.subjectId)!;
    expect(fused.details).toMatchObject({ markings: [MARKED.ukShared, MARKED.caShared], label: ["SECRET//ALPHA/BRAVO//NOFORN"], reason: "not releasable to this subject" });
    expect(fused.reason).toBe("Requires a higher clearance");
  });

  it("CUI is its own regime, and the system's accreditation bounds everyone", async () => {
    const { runtime } = await setup(securityLabels({ levels: LEVELS, homeCountry: "USA", accreditation: { level: "SECRET", cui: true } }));
    expect(await read(runtime, who("TOP_SECRET", { citizenship: "USA" }))).toEqual(["id", "plain"]); // no CUI authorization; TOP_SECRET unaccredited
    expect(await read(runtime, who(undefined, { cuiCategories: ["PRVCY"] }))).toEqual(["id", "plain", "privacy"]);
  });

  it("a scheme with a compilation rule is honored: inputs readable one by one, their combination not", async () => {
    // Two facts together are more sensitive than either: the join adds AGGREGATE, which needs its own access.
    const compiling: ClassificationScheme = {
      name: "compiling",
      join: (ms) => (new Set(ms).size > 1 ? [...new Set(ms), "AGGREGATE"] : [...new Set(ms)]),
      decide: ({ subject, markings }: ClassificationRequest) => ({ allow: markings.every((m) => m !== "AGGREGATE" || subject.attributes.aggregate === true) })
    };
    const { runtime } = await setup(compiling);
    expect(await read(runtime, who(undefined))).toEqual(["caShared", "crown", "id", "plain", "privacy", "ukShared"]);
    expect(await read(runtime, who(undefined, { aggregate: true }))).toContain("fused");
  });

  describe("attack: a scheme whose join misbehaves can't open data", () => {
    const strict = labels;
    const briton = who("SECRET", { compartments: ["ALPHA", "BRAVO"], citizenship: "GBR" });
    for (const [label, join] of [
      ["joins to something weaker", () => ["UNCLASSIFIED"]],
      ["joins to nothing", () => []],
      ["joins to non-strings", () => [7]],
      ["joins to a string", () => "SECRET"],
      ["throws", () => {
        throw new Error("join failed");
      }]
    ] as const) {
      it(`one that ${label}: every marked value stays closed to whoever a marking closes it to`, async () => {
        const broken: ClassificationScheme = { name: "broken-join", join: join as unknown as ClassificationScheme["join"], decide: (r) => strict.decide(r) };
        const { runtime } = await setup(broken);
        const seen = await read(runtime, briton);
        expect(seen).not.toContain("caShared");
        expect(seen).not.toContain("fused");
        expect(seen).not.toContain("crown");
      });
    }

    it("a join to something weaker, beside a decide that answers the real markings without allow: true, still denies", async () => {
      // The weaker join passes; the per-marking floor is what must hold — and only an explicit true counts.
      const sloppy: ClassificationScheme = { name: "sloppy", join: () => ["UNCLASSIFIED"], decide: ({ markings }) => (markings.includes("UNCLASSIFIED") ? { allow: true } : ({} as { allow: boolean })) };
      const { runtime } = await setup(sloppy);
      expect(await read(runtime, who("TOP_SECRET"))).toEqual(["id", "plain"]);
    });

    it("a decide that throws, or answers anything but allow: true, denies", async () => {
      for (const decideFn of [() => ({ allow: "yes" }), () => ({ allow: 1 }), () => undefined, () => {
        throw new Error("down");
      }]) {
        const { runtime } = await setup({ name: "odd", join: (ms) => [...ms], decide: decideFn as unknown as ClassificationScheme["decide"] });
        expect(await read(runtime, who("TOP_SECRET"))).toEqual(["id", "plain"]);
      }
    });
  });

  it("the scheme sees the action and the resource, and never the object's stored values", async () => {
    const seen: ClassificationRequest[] = [];
    const { runtime } = await setup({ name: "spy", join: (ms) => [...ms], decide: (r) => (seen.push(r), { allow: true }) });
    await runtime.getObject("test.Dossier", "d1", who("SECRET"));
    const crown = seen.find((r) => r.context.resource.propertyPath === "crown")!;
    expect(crown.context).toEqual({ action: "read", resource: { typeName: "test.Dossier", objectId: "d1", propertyPath: "crown" } });
    expect(JSON.stringify(seen.map((r) => r.context))).not.toMatch(/FACT|PLAIN/);
    await expect(runtime.getProvenance("test.Dossier", "d1", "crown", who(undefined, {}))).resolves.toBeDefined();
    await expect((await setup(labels)).runtime.getProvenance("test.Dossier", "d1", "crown", who("SECRET"))).rejects.toBeInstanceOf(AuthorizationError);
  });
});
