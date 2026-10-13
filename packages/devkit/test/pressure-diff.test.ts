/**
 * Adversarial review of diffModels (ADR-0056): changes that break an existing
 * consumer must not be reported as compatible, or not at all.
 */
import { describe, it, expect } from "vitest";
import type { ActionDescription, ModelDescription, TypeDescription } from "@typesys/core";
import { diffModels } from "../src/index.js";

const type = (over: Partial<TypeDescription> = {}): TypeDescription => ({
  name: "x.T",
  version: "1.0.0",
  traits: [],
  properties: { id: { type: "string" }, code: { type: "string" }, count: { type: "integer" } },
  required: ["id", "code"],
  computed: [],
  relationships: [],
  actions: [],
  ...over
});
const action = (over: Partial<ActionDescription> = {}): ActionDescription => ({
  name: "DoIt",
  version: "1.0.0",
  description: "",
  applicableTypes: ["x.T"],
  inputSchema: { type: "object", required: ["note"], properties: { note: { type: "string" }, amount: { type: "number" } } },
  outputSchema: { type: "object", required: ["ref"], properties: { ref: { type: "string" } } },
  sideEffects: "mutates",
  idempotency: "none",
  ...over
});
const model = (t: TypeDescription, a: ActionDescription): ModelDescription => ({ format: "typesys.model/1", types: [t], actions: [a] });
const base = model(type(), action());
/** The impact the diff gives a change (none when it reports nothing). */
const breaking = (after: ModelDescription) => diffModels(base, after).changes.some((c) => c.impact === "breaking");

describe("pressure: diffModels misses breaking changes", () => {
  it("a Type value that was required becomes optional (readers now see undefined)", () => {
    expect(diffModels(base, model(type({ version: "1.0.1", required: ["id"] }), action())).changes).not.toEqual([]);
  });

  it("an Action input narrowed from number to integer (1.5 now refused)", () => {
    expect(breaking(model(type(), action({ version: "1.0.1", inputSchema: { type: "object", required: ["note"], properties: { note: { type: "string" }, amount: { type: "integer" } } } })))).toBe(true);
  });

  it("an Action input given a maxLength / pattern / minimum (inputs that passed now refused)", () => {
    const tightened = action({
      version: "1.0.1",
      inputSchema: { type: "object", required: ["note"], properties: { note: { type: "string", maxLength: 3, pattern: "^[A-Z]+$" }, amount: { type: "number", minimum: 1000 } } }
    });
    expect(breaking(model(type(), tightened))).toBe(true);
  });

  it("an Action's input closed off with additionalProperties: false (extra inputs now refused)", () => {
    const closed = action({ version: "1.0.1", inputSchema: { ...action().inputSchema, additionalProperties: false } });
    expect(breaking(model(type(), closed))).toBe(true);
  });

  it("an Action output that was required becomes optional", () => {
    const loose = action({ version: "1.0.1", outputSchema: { type: "object", properties: { ref: { type: "string" } } } });
    expect(diffModels(base, model(type(), loose)).changes).not.toEqual([]);
  });

  it("a stored value narrowed by format or widened from integer to number", () => {
    const after = model(type({ version: "1.0.1", properties: { id: { type: "string" }, code: { type: "string", format: "uuid" }, count: { type: "number" } } }), action());
    expect(diffModels(base, after).changes.map((c) => c.subject).sort()).toEqual(["x.T.code", "x.T.count"]);
  });

  it("a relationship alias removed (queries including the old name now fail; the runtime resolves only relationship aliases)", () => {
    const rel = [{ name: "parts", target: "x.T", cardinality: "one-to-many" as const }];
    const before = model(type({ relationships: rel, aliases: { components: "parts" } }), action());
    const after = model(type({ version: "1.0.1", relationships: rel }), action());
    expect(diffModels(before, after).changes.some((c) => c.impact === "breaking")).toBe(true);
  });
});
