import { describe, it, expect } from "vitest";
import { isAnonymous, narrowModel, type ActionDefinition, type DiscoveryGate, type ModelDescription, type TypeDefinition } from "../src/index.js";

/**
 * `narrowModel` (ADR-0068) against a gate that answers from fixed sets, so
 * each closure rule is shown on its own: nothing a description keeps may
 * name something it withholds.
 */
const model: ModelDescription = {
  format: "typesys.model/1",
  types: [
    {
      name: "x.Base",
      version: "1.0.0",
      traits: [],
      properties: { id: { type: "string" } },
      required: ["id"],
      computed: [],
      relationships: [],
      actions: []
    },
    {
      name: "x.Thing",
      version: "1.0.0",
      extends: "x.Base",
      traits: [],
      properties: { id: { type: "string" }, open: { type: "string" }, secret: { type: "string" } },
      required: ["id", "secret"],
      computed: [
        { name: "fromSecret", dependsOn: ["secret"] },
        { name: "releasedFlag", dependsOn: ["secret"] },
        { name: "fromOpen", dependsOn: ["open"] },
        { name: "chained", dependsOn: ["fromSecret"] },
        { name: "unknownInput", dependsOn: ["nowhere"] }
      ],
      relationships: [
        { name: "toHidden", target: "x.Hidden", cardinality: "one-to-many" },
        { name: "toBase", target: "x.Base", cardinality: "one-to-one" }
      ],
      actions: ["Open", "OnHidden", "Denied", "Targeted"],
      aliases: { oldOpen: "open", oldSecret: "secret" }
    },
    { name: "x.Hidden", version: "1.0.0", traits: [], properties: { id: { type: "string" } }, required: [], computed: [], relationships: [], actions: ["OnHidden"] }
  ],
  actions: [
    { name: "Denied", version: "1.0.0", description: "", applicableTypes: ["x.Thing"], inputSchema: {}, outputSchema: {}, sideEffects: "mutates", idempotency: "none" },
    { name: "OnHidden", version: "1.0.0", description: "", applicableTypes: ["x.Hidden", "x.Thing"], inputSchema: {}, outputSchema: {}, sideEffects: "mutates", idempotency: "none" },
    { name: "Open", version: "1.0.0", description: "", applicableTypes: ["x.Thing"], inputSchema: {}, outputSchema: {}, sideEffects: "mutates", idempotency: "none" },
    { name: "Targeted", version: "1.0.0", description: "", applicableTypes: ["x.Thing"], inputSchema: {}, outputSchema: {}, target: { type: "x.Hidden", idFrom: "id" }, sideEffects: "mutates", idempotency: "none" }
  ]
};

const def = (name: string, releases: Record<string, string[]> = {}) =>
  ({ name, computedProperties: Object.entries(releases).map(([n, r]) => ({ name: n, releases: r })) }) as unknown as TypeDefinition;
const definitions = new Map([
  ["x.Base", def("x.Base")],
  ["x.Thing", def("x.Thing", { releasedFlag: ["secret"] })],
  ["x.Hidden", def("x.Hidden")]
]);
const actionDefinitions = new Map(model.actions.map((a) => [a.name, { name: a.name } as ActionDefinition]));

const gate = (opts: { types: string[]; withheld?: string[]; actions?: string[] }): DiscoveryGate => ({
  typeReadable: async (t) => opts.types.includes(t.name),
  memberReadable: async (_t, member) => !(opts.withheld ?? []).includes(member),
  actionInvocable: async (a) => (opts.actions ?? []).includes(a.name)
});

describe("narrowModel (ADR-0068)", () => {
  it("keeps a relationship only to a described Type, and extends only a described base", async () => {
    const { model: narrowed } = await narrowModel(model, definitions, actionDefinitions, gate({ types: ["x.Thing"] }));
    const thing = narrowed.types.find((t) => t.name === "x.Thing")!;
    expect(narrowed.types.map((t) => t.name)).toEqual(["x.Thing"]);
    expect(thing.relationships).toEqual([]);
    expect(thing).not.toHaveProperty("extends");
    const withBase = (await narrowModel(model, definitions, actionDefinitions, gate({ types: ["x.Thing", "x.Base"] }))).model.types.find((t) => t.name === "x.Thing")!;
    expect(withBase.relationships.map((r) => r.name)).toEqual(["toBase"]);
    expect(withBase.extends).toBe("x.Base");
  });

  it("withholds a computed value over a withheld input unless it releases it, and never names the withheld input", async () => {
    const { model: narrowed, withheld } = await narrowModel(model, definitions, actionDefinitions, gate({ types: ["x.Thing"], withheld: ["secret"] }));
    const thing = narrowed.types.find((t) => t.name === "x.Thing")!;
    expect(Object.keys(thing.properties)).toEqual(["id", "open"]);
    expect(thing.computed).toEqual([
      { name: "releasedFlag", dependsOn: [] },
      { name: "fromOpen", dependsOn: ["open"] }
    ]);
    expect(thing.required).toEqual(["id"]);
    expect(thing.aliases).toEqual({ oldOpen: "open" });
    expect(JSON.stringify(narrowed)).not.toContain("secret");
    expect(JSON.stringify(narrowed)).not.toContain("fromSecret");
    // secret; fromSecret, chained (over fromSecret) and unknownInput (over nothing described); both relationships.
    expect(withheld).toEqual({ types: 2, members: 6, actions: 4 });
  });

  it("keeps a computed value over a computed value it keeps", async () => {
    const thing = (await narrowModel(model, definitions, actionDefinitions, gate({ types: ["x.Thing"] }))).model.types.find((t) => t.name === "x.Thing")!;
    expect(thing.computed.map((c) => c.name)).toEqual(["fromSecret", "releasedFlag", "fromOpen", "chained"]);
  });

  it("keeps an Action the caller may invoke on a described Type, lists only its described Types, and drops one whose target is withheld", async () => {
    const { model: narrowed } = await narrowModel(model, definitions, actionDefinitions, gate({ types: ["x.Thing"], actions: ["Open", "OnHidden", "Targeted"] }));
    expect(narrowed.actions.map((a) => [a.name, a.applicableTypes])).toEqual([
      ["OnHidden", ["x.Thing"]],
      ["Open", ["x.Thing"]]
    ]);
    expect(narrowed.types.find((t) => t.name === "x.Thing")!.actions).toEqual(["Open", "OnHidden"]);
  });

  it("an anonymous caller is the resolvers' anonymous subject, or no subject at all", () => {
    expect(isAnonymous({ subjectId: "anonymous", roles: ["viewer"], attributes: {} })).toBe(true);
    expect(isAnonymous({ subjectId: "", roles: [], attributes: {} })).toBe(true);
    expect(isAnonymous({ subjectId: "user-1", roles: [], attributes: {} })).toBe(false);
  });
});
