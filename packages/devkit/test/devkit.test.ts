import { describe, it, expect, beforeAll } from "vitest";
import { describeModel, type ModelDescription, type QueryOperator, type SemanticQuery } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, type AirforceTestbed } from "@typesys/domain-airforce";
import { buildHospitalTestbed } from "@typesys/domain-hospital";
import { readTypes } from "../../mcp-server/src/reads.js";
import { compactCatalog, didYouMean, diffModels, discover, validateQuery } from "../src/index.js";

let airforce: AirforceTestbed;
let afModel: ModelDescription;
let both: ModelDescription;

beforeAll(async () => {
  airforce = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  afModel = await describeModel(airforce.registry, { prefixes: ["airforce."] });
  const hospital = await describeModel((await buildHospitalTestbed()).registry, { prefixes: ["hospital."] });
  both = { format: "typesys.model/1", types: [...afModel.types, ...hospital.types], actions: [...afModel.actions, ...hospital.actions] };
});

const clone = (m: ModelDescription): ModelDescription => structuredClone(m);

describe("compact catalog (ADR-0056)", () => {
  it("describes a model in under half of what typesys_list_types returns", async () => {
    // The same Types both ways: every registered one. The numbers are in docs/evidence/devkit-2026-10-13.md; the
    // listing lost its policy, marking and binding keywords to ADR-0068, so the margin is smaller than it was.
    const full = JSON.stringify({ types: await readTypes(airforce.registry, airforce.runtime, demoIdentities.maintainer) });
    const compact = compactCatalog(await describeModel(airforce.registry));
    expect(compact.length).toBeLessThan(full.length / 2);
    expect(compact).toContain("computed: readinessStatus: \"FMC\" | \"PMC\" | \"NMC\" | \"UNKNOWN\", needsAttention: boolean");
    expect(compact).toContain("on one airforce.WorkOrder (id in workOrderId); mutates; idempotency natural");
  });
});

describe("discover (ADR-0056)", () => {
  // Written before ranking was tuned, and kept including the miss it cannot make: discovery is lexical.
  const TASKS: [string, string][] = [
    ["which aircraft need attention", "airforce.Aircraft"],
    ["close a work order", "UpdateWorkOrderStatus"],
    ["open a work order for a maintenance event", "CreateMaintenanceWorkOrder"],
    ["a patient's upcoming appointments", "hospital.Appointment"],
    ["part condition of installed components", "airforce.Component"],
    ["where is the jet deployed", "airforce.Aircraft"]
  ];

  it("ranks the intended Type or Action first for each task", () => {
    for (const [task, expected] of TASKS) expect(discover(both, task)[0]?.name, task).toBe(expected);
  });

  it("does not know synonyms the model's own words don't contain", () => {
    expect(discover(both, "which doctor specializes in cardiology")).toEqual([]);
  });

  it("returns compact summaries, bounded by limit, and everything for an empty task", () => {
    const [first] = discover(both, "aircraft attention", { limit: 1 });
    expect(first).toMatchObject({ kind: "type", name: "airforce.Aircraft", matched: ["aircraft", "attention"] });
    expect(first!.summary.split("\n")[0]).toMatch(/^airforce\.Aircraft — /);
    expect(discover(both, "", { limit: 100 })).toHaveLength(both.types.length + both.actions.length);
  });
});

describe("validateQuery (ADR-0056)", () => {
  const codes = (q: unknown) => validateQuery(afModel, q).map((d) => [d.code, d.path, d.suggestion]);

  it("accepts what the model allows", () => {
    expect(
      validateQuery(afModel, {
        type: "airforce.Aircraft",
        filter: { and: [{ property: "needsAttention", operator: "eq", value: true }, { property: "readinessStatus", operator: "in", value: ["FMC", "PMC"] }] },
        select: ["tailNumber", "readinessStatus"],
        sort: [{ property: "tailNumber" }],
        search: { text: "f-16", properties: ["model"] },
        include: [{ relationship: "maintenance", sort: [{ property: "occurredAt", direction: "desc" }], include: [{ relationship: "workOrder", filter: { property: "status", operator: "ne", value: "closed" } }] }]
      })
    ).toEqual([]);
  });

  it("names each mistake by path, with the name probably meant", () => {
    expect(codes({ type: "airforce.Aircrft" })).toEqual([["unknown-type", "/type", "airforce.Aircraft"]]);
    expect(codes({ type: "Aircraft" })).toEqual([["unknown-type", "/type", "airforce.Aircraft"]]);
    expect(codes({ type: "airforce.Aircraft", filter: { or: [{ property: "tailNumber", operator: "eq", value: "x" }, { property: "tailNumbr", operator: "eq", value: "x" }] } })).toEqual([
      ["unknown-property", "/filter/or/1/property", "tailNumber"]
    ]);
    expect(codes({ type: "airforce.Aircraft", sort: [{ property: "readinessStatus" }] })).toEqual([["computed-property", "/sort/0/property", undefined]]);
    expect(codes({ type: "airforce.Aircraft", search: { text: "x", properties: ["needsAttention"] } })).toEqual([["computed-property", "/search/properties/0", undefined]]);
    expect(codes({ type: "airforce.Aircraft", filter: { property: "tailNumber", operator: "gt", value: "A" } })).toEqual([["operator-never-matches", "/filter/operator", undefined]]);
    expect(codes({ type: "airforce.Aircraft", filter: { property: "readinessStatus", operator: "in", value: ["FMC", "GREEN"] } })).toEqual([["value-never-matches", "/filter/value/1", undefined]]);
    expect(codes({ type: "airforce.Aircraft", filter: { property: "needsAttention", operator: "eq", value: "true" } })).toEqual([["value-never-matches", "/filter/value", undefined]]);
    expect(codes({ type: "airforce.Aircraft", include: [{ relationship: "component" }] })).toEqual([["unknown-relationship", "/include/0/relationship", "components"]]);
    expect(codes({ type: "airforce.Aircraft", include: [{ relationship: "components", select: ["partNum"] }] })).toEqual([["unknown-property", "/include/0/select/0", "partNumber"]]);
    expect(codes({ type: "airforce.Aircraft", limit: 0 })).toEqual([["invalid-query", "", undefined]]);
  });

  it("is sound against the runtime: what it accepts the runtime accepts, and what it says never matches returns nothing", async () => {
    // Every value of two Types, every operator, and values drawn from the data, the enums and wrong kinds.
    const values: unknown[] = ["AF86-0147", "F-16C", "degraded", "FMC", "good", "f-16", 3, true, null, ["x"]];
    const operators: QueryOperator[] = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "icontains"];
    const maintainer = demoIdentities.maintainer;
    const everything = new Map<string, number>();
    for (const t of ["airforce.Aircraft", "airforce.Component"]) everything.set(t, (await airforce.runtime.query({ type: t }, maintainer)).items.length);
    const cases = afModel.types
      .filter((t) => everything.has(t.name))
      .flatMap((type) =>
        [...Object.keys(type.properties), ...type.computed.map((c) => c.name)].flatMap((property) =>
          operators.flatMap((operator) => values.map((value): SemanticQuery => ({ type: type.name, filter: { property, operator, value: operator === "in" ? [value] : value } })))
        )
      );
    // Run concurrently: each is independent, and the maintenance adapter's simulated latency dominates otherwise.
    const outcomes = await Promise.all(
      cases.map(async (query) => {
        try {
          return (await airforce.runtime.query(query, maintainer)).items.length;
        } catch (err) {
          if ((err as Error).name !== "InvalidInputError") throw err;
          return "refused" as const;
        }
      })
    );
    let accepted = 0;
    let neverMatch = 0;
    cases.forEach((query, i) => {
      const rows = outcomes[i];
      const diagnostics = validateQuery(afModel, query);
      const label = JSON.stringify(query);
      const errors = diagnostics.filter((d) => d.severity === "error");
      if (errors.length === 0) {
        accepted++;
        expect(rows, label).not.toBe("refused");
        // A condition said to filter nothing returns every object the plain query does.
        if (diagnostics.some((d) => d.code === "always-matches")) expect(rows, label).toBe(everything.get(query.type));
      } else {
        neverMatch++;
        expect(["operator-never-matches", "value-never-matches"]).toContain(errors[0]!.code);
        expect([0, "refused"], label).toContain(rows);
      }
    });
    expect(accepted).toBeGreaterThan(100);
    expect(neverMatch).toBeGreaterThan(100);
  }, 120_000);
});

describe("diffModels (ADR-0056)", () => {
  const aircraft = (m: ModelDescription) => m.types.find((t) => t.name === "airforce.Aircraft")!;
  const action = (m: ModelDescription, name: string) => m.actions.find((a) => a.name === name)!;

  it("finds nothing between a model and itself", () => {
    expect(diffModels(afModel, clone(afModel))).toEqual({ changes: [], underVersioned: [] });
  });

  it("classifies each change by how it lands on an existing consumer, and checks the version moved far enough", () => {
    const after = clone(afModel);
    delete aircraft(after).properties.deploymentLocation;
    aircraft(after).properties.serviceBranch = { type: "string" };
    (aircraft(after).computed.find((c) => c.name === "readinessStatus")!.schema!.enum as string[]).push("DEPOT");
    const update = action(after, "UpdateWorkOrderStatus");
    update.inputSchema = structuredClone(update.inputSchema);
    update.inputSchema.properties!.reason = { type: "string" };
    update.inputSchema.required = [...update.inputSchema.required!, "reason"];
    (update.inputSchema.properties!.status!.enum as string[]).push("cancelled");

    const { changes, underVersioned } = diffModels(afModel, after);
    expect(changes).toEqual(
      expect.arrayContaining([
        { impact: "breaking", subject: "airforce.Aircraft.deploymentLocation", change: "value removed" },
        { impact: "compatible", subject: "airforce.Aircraft.serviceBranch", change: "value added" },
        { impact: "risky", subject: "airforce.Aircraft.readinessStatus", change: 'now may be "DEPOT"' },
        { impact: "breaking", subject: "UpdateWorkOrderStatus.input.reason", change: "required input added" },
        { impact: "compatible", subject: "UpdateWorkOrderStatus.input.status", change: 'now accepts "cancelled"' }
      ])
    );
    expect(changes).toHaveLength(5);
    expect(underVersioned).toEqual([
      { subject: "airforce.Aircraft", from: "1.0.0", to: "1.0.0", needs: "major" },
      { subject: "UpdateWorkOrderStatus", from: update.version, to: update.version, needs: "major" }
    ]);

    aircraft(after).version = "2.0.0";
    update.version = "2.0.0";
    expect(diffModels(afModel, after).underVersioned).toEqual([]);
    aircraft(after).version = "1.1.0";
    expect(diffModels(afModel, after).underVersioned.map((v) => v.subject)).toEqual(["airforce.Aircraft"]);
  });

  it("treats a renamed relationship kept as an alias as risky, a dropped one as breaking, and removed Types and Actions as breaking", () => {
    const renamed = clone(afModel);
    aircraft(renamed).relationships[0]!.name = "installedComponents";
    aircraft(renamed).aliases = { components: "installedComponents" };
    aircraft(renamed).version = "1.1.0";
    expect(diffModels(afModel, renamed)).toEqual({
      changes: [{ impact: "risky", subject: "airforce.Aircraft.components", change: "renamed to installedComponents; the old name is accepted as an alias for now (ADR-0010)" }],
      underVersioned: []
    });
    delete aircraft(renamed).aliases;
    expect(diffModels(afModel, renamed).changes).toContainEqual({ impact: "breaking", subject: "airforce.Aircraft.components", change: "relationship removed" });

    const removed = clone(afModel);
    removed.types = removed.types.filter((t) => t.name !== "airforce.Component");
    removed.actions = [];
    expect(diffModels(afModel, removed).changes.filter((c) => c.impact === "breaking").map((c) => c.subject).sort()).toEqual(
      ["CreateMaintenanceWorkOrder", "UpdateWorkOrderStatus", "airforce.Component"].sort()
    );
  });

  it("calls a removed enum value breaking, both in what a consumer reads and in what it sends", () => {
    const after = clone(afModel);
    const status = aircraft(after).properties.maintenanceStatus!;
    status.enum = status.enum!.filter((v) => v !== "down");
    const input = action(after, "UpdateWorkOrderStatus").inputSchema.properties!.status!;
    input.enum = input.enum!.filter((v) => v !== "open");
    expect(diffModels(afModel, after).changes).toEqual([
      { impact: "breaking", subject: "airforce.Aircraft.maintenanceStatus", change: 'can no longer be "down"' },
      { impact: "breaking", subject: "UpdateWorkOrderStatus.input.status", change: 'no longer accepts "open"' }
    ]);
  });

  it("calls a change of Action scope breaking (ADR-0053)", () => {
    const after = clone(afModel);
    delete action(after, "UpdateWorkOrderStatus").target;
    expect(diffModels(afModel, after).changes).toContainEqual({
      impact: "breaking",
      subject: "UpdateWorkOrderStatus",
      change: "now decided per Type, was one airforce.WorkOrder (id in workOrderId) (ADR-0053)"
    });
  });
});

describe("didYouMean", () => {
  it("suggests only a close name", () => {
    expect(didYouMean("statsu", ["status", "assignedTo"])).toBe("status");
    expect(didYouMean("colour", ["condition", "partNumber"])).toBeUndefined();
  });
});
