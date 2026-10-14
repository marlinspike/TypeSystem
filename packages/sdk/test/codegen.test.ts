import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { allowAllRule, buildRuntime, coreManifest, ComputedValueError, describeModel, type DomainManifest } from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { generateModel, schemaToTs } from "../src/index.js";
import { driftedModels } from "../../../scripts/generate-sdk-models.js";

describe("schemaToTs", () => {
  it("covers the vocabulary TypeS models author, and widens what it cannot express", () => {
    expect(schemaToTs({ type: "string" })).toBe("string");
    expect(schemaToTs({ type: "integer" })).toBe("number");
    expect(schemaToTs({ type: ["string", "null"] })).toBe("string | null");
    expect(schemaToTs({ enum: ["a", 1, null] })).toBe('"a" | 1 | null');
    expect(schemaToTs({ const: true })).toBe("true");
    expect(schemaToTs({ type: "array", items: { enum: ["x", "y"] } })).toBe('("x" | "y")[]');
    expect(schemaToTs({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
    expect(schemaToTs({ type: "object", properties: { a: { type: "string" }, "b-c": { type: "number" } }, required: ["a"] })).toBe('{\n  a: string;\n  "b-c"?: number;\n}');
    expect(schemaToTs({ type: "object", additionalProperties: { type: "boolean" } })).toBe("{\n  [key: string]: boolean;\n}");
    expect(schemaToTs({ type: "object" })).toBe("Record<string, unknown>");
    expect(schemaToTs({ $ref: "https://typesys.dev/x" })).toBe("unknown");
    expect(schemaToTs({ anyOf: [{ type: "string" }, { $ref: "#/x" }] })).toBe("unknown");
    expect(schemaToTs(undefined)).toBe("unknown");
  });
});

const tinyDomain = (computeBad: boolean): DomainManifest => ({
  domain: "tiny",
  dataSources: [{ id: "tiny-ds", name: "tiny", kind: "in-memory" }],
  types: [
    {
      schema: {
        $id: "https://typesys.dev/types/tiny/Thing/1.0.0",
        title: "Thing",
        type: "object",
        properties: { id: { type: "string" }, size: { type: "integer" } },
        required: ["id"],
        "x-computed": { big: { dependsOn: ["size"], binding: "big", schema: { type: "boolean" } } },
        "x-policy": { objectPolicy: "tiny.read" }
      },
      options: {
        name: "tiny.Thing",
        version: "1.0.0",
        computedImplementations: { big: async (ctx) => (computeBad ? "yes" : ((await ctx.getProperty("size")) as number) > 10) }
      }
    }
  ],
  mappings: [{ id: "map-thing", typeName: "tiny.Thing", target: "property", targetName: "*", dataSourceId: "tiny-ds", operation: "get", resolutionMode: "live" }]
});

async function tinyRuntime(computeBad: boolean) {
  const adapter = new InMemoryRepositoryAdapter("tiny-ds", "tiny");
  adapter.seed("tiny.Thing", [{ objectId: "t1", values: { id: "t1", size: 12 } }]);
  return buildRuntime({ manifests: [coreManifest, tinyDomain(computeBad)], adapters: [adapter], policyRules: { "tiny.read": allowAllRule } });
}

describe("generateModel", () => {
  it("keeps every committed domain model in step with its registry", async () => {
    expect(await driftedModels()).toEqual([]);
  });

  it("emits a model that compiles under --strict", async () => {
    const { registry } = await tinyRuntime(false);
    const code = generateModel(await describeModel(registry, { prefixes: ["tiny."] }), { name: "TinyModel" });
    expect(code).toContain("big: boolean;");
    const dir = await mkdtemp(path.join(tmpdir(), "typesys-sdk-"));
    await writeFile(path.join(dir, "model.ts"), code);
    const tsc = path.resolve(import.meta.dirname, "../../../node_modules/typescript/bin/tsc");
    await promisify(execFile)(process.execPath, [tsc, "--noEmit", "--strict", "--target", "ES2023", "model.ts"], { cwd: dir });
  }, 60_000);
});

describe("declared computed value schemas (ADR-0055)", () => {
  it("are enforced: a value the schema does not admit fails the read, never reaches a typed client", async () => {
    const identity = { subjectId: "u", roles: [], attributes: {} };
    expect((await (await tinyRuntime(false)).runtime.getObject("tiny.Thing", "t1", identity)).values.big).toBe(true);
    await expect((await tinyRuntime(true)).runtime.getObject("tiny.Thing", "t1", identity)).rejects.toBeInstanceOf(ComputedValueError);
  });

  it("are checked at registration", async () => {
    const bad = tinyDomain(false);
    (bad.types[0]!.schema["x-computed"]!.big as { schema: unknown }).schema = { type: "nonsense" };
    await expect(buildRuntime({ manifests: [coreManifest, bad], adapters: [new InMemoryRepositoryAdapter("tiny-ds", "tiny")], policyRules: {} })).rejects.toThrow(/invalid value schema/);
  });
});
