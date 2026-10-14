import { describe, it, expect } from "vitest";
import { createSemanticValidator, describeModel, type JsonSchema2020 } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { buildHospitalTestbed } from "@typesys/domain-hospital";
import { synthesize, synthesizeObjects, UnsupportedSchemaError } from "../src/index.js";

describe("synthetic data (ADR-0057)", () => {
  it("every value it synthesizes, the schema admits: every value and Action output of both demo models, 50 seeds each", async () => {
    const ajv = createSemanticValidator();
    const schemas: [string, JsonSchema2020][] = [];
    for (const registry of [(await buildAirforceTestbed()).registry, (await buildHospitalTestbed()).registry]) {
      const model = await describeModel(registry);
      for (const t of model.types) {
        schemas.push([t.name, { type: "object", properties: t.properties, required: t.required }]);
        for (const c of t.computed) if (c.schema) schemas.push([`${t.name}.${c.name}`, c.schema]);
      }
      for (const a of model.actions) schemas.push([`${a.name} input`, a.inputSchema], [`${a.name} output`, a.outputSchema]);
    }
    expect(schemas.length).toBeGreaterThan(20);
    const rejected: string[] = [];
    for (const [label, schema] of schemas) {
      const validate = ajv.compile(schema);
      for (let seed = 1; seed <= 50; seed++) if (!validate(synthesize(schema, seed))) rejected.push(`${label} seed ${seed}: ${ajv.errorsText(validate.errors)}`);
    }
    expect(rejected).toEqual([]);
  });

  it("honors bounds, formats and references, is the same for the same seed, and refuses what it cannot honor", () => {
    const ajv = createSemanticValidator();
    const schema: JsonSchema2020 = {
      type: "object",
      properties: {
        n: { type: "integer", exclusiveMinimum: 3, maximum: 4 },
        x: { type: "number", minimum: 0, exclusiveMaximum: 1 },
        at: { type: "string", format: "date-time" },
        tags: { type: "array", minItems: 2, maxItems: 2, items: { $ref: "#/$defs/tag" } },
        code: { type: "string", minLength: 20, maxLength: 20 }
      },
      required: ["n", "x", "at", "tags", "code"],
      $defs: { tag: { enum: ["a", "b"] } }
    };
    const validate = ajv.compile(schema);
    for (let seed = 1; seed <= 200; seed++) expect(validate(synthesize(schema, seed))).toBe(true);
    expect(synthesize(schema, 7)).toEqual(synthesize(schema, 7));
    expect(synthesize(schema, 7)).not.toEqual(synthesize(schema, 8));
    expect(() => synthesize({ type: "string", pattern: "^[A-Z]{3}$" })).toThrow(UnsupportedSchemaError);
    expect(() => synthesize({ type: "integer", minimum: 1, maximum: 0 })).toThrow(UnsupportedSchemaError);
  });

  it("seeds a source with synthetic objects that the runtime then governs like any other", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const objects = synthesizeObjects(await describeModel(tb.registry), "airforce.Aircraft", 25, 3);
    expect(new Set(objects.map((o) => o.objectId)).size).toBe(25);
    tb.inMemoryAdapter.seed("airforce.Aircraft", objects);
    const asViewer = await tb.runtime.query({ type: "airforce.Aircraft", filter: { property: "id", operator: "eq", value: "SYN-AIR-0001" } }, demoIdentities.viewer);
    expect(asViewer.items).toHaveLength(1);
    // SECRET deploymentLocation and the maintainer-only maintenanceStatus are withheld from the viewer, synthetic or not.
    expect(asViewer.items[0]!.values).not.toHaveProperty("deploymentLocation");
    expect(asViewer.items[0]!.values).not.toHaveProperty("maintenanceStatus");
    expect(asViewer.items[0]!.values.tailNumber).toEqual(objects[0]!.values.tailNumber);
  });
});
