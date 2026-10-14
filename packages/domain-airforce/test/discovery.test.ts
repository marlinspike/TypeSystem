import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import {
  AuthorizationError,
  HIGH_ASSURANCE_V2,
  SecurityProfileError,
  withAudience,
  type Audience,
  type Identity,
  type ModelDescription,
  type SemanticRuntime,
  type TypeDescription
} from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, type AirforceTestbed } from "../src/setup.js";

/**
 * Discovery is decided by the runtime (ADR-0068). Under need-to-know a
 * caller learns the Types they may read some object of, the members of
 * those they may read, and the Actions they may invoke, decided by the same
 * policies, plans and markings as their reads; nothing in a description
 * names what it withholds.
 */
const { maintainer, viewer, anonymous } = demoIdentities;
const AIRFORCE = ["airforce.Aircraft", "airforce.Component", "airforce.MaintenanceEvent", "airforce.WorkOrder"];

const type = (model: ModelDescription, name: string): TypeDescription | undefined => model.types.find((t) => t.name === name);
const members = (t: TypeDescription | undefined) => new Set([...Object.keys(t?.properties ?? {}), ...(t?.computed ?? []).map((c) => c.name), ...(t?.relationships ?? []).map((r) => r.name)]);

/** Every name a description mentions: Types it extends or relates to, inputs, aliases, Actions. All must be described themselves. */
function dangling(model: ModelDescription): string[] {
  const types = new Set(model.types.map((t) => t.name));
  const actions = new Set(model.actions.map((a) => a.name));
  const out: string[] = [];
  for (const t of model.types) {
    const own = members(t);
    if (t.extends && !types.has(t.extends)) out.push(`${t.name} extends ${t.extends}`);
    for (const r of t.relationships) if (!types.has(r.target)) out.push(`${t.name}.${r.name} -> ${r.target}`);
    for (const c of t.computed) for (const dep of c.dependsOn) if (!own.has(dep)) out.push(`${t.name}.${c.name} <- ${dep}`);
    for (const [old, current] of Object.entries(t.aliases ?? {})) if (!own.has(current)) out.push(`${t.name} alias ${old} -> ${current}`);
    for (const r of t.required) if (!own.has(r)) out.push(`${t.name} requires ${r}`);
    for (const a of t.actions) if (!actions.has(a)) out.push(`${t.name} action ${a}`);
  }
  for (const a of model.actions) for (const t of a.applicableTypes) if (!types.has(t)) out.push(`${a.name} on ${t}`);
  return out;
}

describe("need-to-know discovery (ADR-0068)", () => {
  let tb: AirforceTestbed;
  beforeAll(async () => {
    tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { discovery: "need-to-know" } });
  });

  it("a maintainer cleared SECRET learns every airforce Type with its SECRET location, maintenanceStatus and both Actions", async () => {
    const model = await tb.runtime.describeModel(maintainer);
    expect(model.types.map((t) => t.name)).toEqual(AIRFORCE);
    expect(Object.keys(type(model, "airforce.Aircraft")!.properties)).toEqual(expect.arrayContaining(["deploymentLocation", "maintenanceStatus"]));
    expect(model.actions.map((a) => a.name)).toEqual(["CreateMaintenanceWorkOrder", "UpdateWorkOrderStatus"]);
    expect(dangling(model)).toEqual([]);
  });

  it("a viewer is not told deploymentLocation, maintenanceStatus, the value computed from it, or any Action; the released flag stays, naming no input", async () => {
    const model = await tb.runtime.describeModel(viewer);
    const aircraft = type(model, "airforce.Aircraft")!;
    expect(Object.keys(aircraft.properties)).not.toContain("deploymentLocation");
    expect(Object.keys(aircraft.properties)).not.toContain("maintenanceStatus");
    expect(aircraft.computed).toEqual([{ name: "needsAttention", dependsOn: [], schema: { type: "boolean" } }]);
    expect(model.actions).toEqual([]);
    expect(model.types.every((t) => t.actions.length === 0)).toBe(true);
    // Not even by name, anywhere in what it is sent.
    const text = JSON.stringify(model);
    for (const secret of ["deploymentLocation", "maintenanceStatus", "readinessStatus", "CreateMaintenanceWorkOrder", "UpdateWorkOrderStatus", "core.Asset"]) expect(text).not.toContain(secret);
    expect(dangling(model)).toEqual([]);
  });

  it("an anonymous caller is refused, and the refusal is audited", async () => {
    await expect(tb.runtime.describeModel(anonymous)).rejects.toThrow(AuthorizationError);
    await expect(tb.runtime.listActions("airforce.MaintenanceEvent", anonymous)).rejects.toThrow(AuthorizationError);
    const rows = (await tb.registry.listAuditEvents({ limit: 500 })).items.filter((e) => e.subjectId === "anonymous" && e.action === "describe-model");
    expect(rows[0]).toMatchObject({ decision: "deny", details: { discovery: "need-to-know" } });
  });

  it("is decided for the model an agent reads for too (ADR-0067): the enclave model is not told the SECRET location; a commercial model is told nothing", async () => {
    const enclave = await tb.runtime.describeModel(withAudience(maintainer, demoAudiences.enclaveModel));
    expect(Object.keys(type(enclave, "airforce.Aircraft")!.properties)).toContain("maintenanceStatus");
    expect(Object.keys(type(enclave, "airforce.Aircraft")!.properties)).not.toContain("deploymentLocation");
    const commercial = await tb.runtime.describeModel(withAudience(maintainer, demoAudiences.commercialModel));
    expect(commercial).toEqual({ format: "typesys.model/1", types: [], actions: [] });
  });

  it("listActions agrees: a viewer is told of no Action, a maintainer of the instance-scoped one before naming an object", async () => {
    expect(await tb.runtime.listActions("airforce.WorkOrder", viewer)).toEqual([]);
    expect(await tb.runtime.listActions("core.Asset", maintainer)).toEqual([]);
    const listed = await tb.runtime.listActions("airforce.WorkOrder", maintainer);
    expect(listed.map((l) => [l.action.name, l.instanceScoped])).toEqual([["UpdateWorkOrderStatus", true]]);
  });

  it("each call is one audit row: the mode, and what was described and withheld, by count", async () => {
    await tb.runtime.describeModel(viewer);
    const row = (await tb.registry.listAuditEvents({ limit: 500 })).items.find((e) => e.subjectId === viewer.subjectId && e.action === "describe-model");
    expect(row).toMatchObject({ decision: "allow", operation: "describeModel", details: { discovery: "need-to-know", types: 4, actions: 0 } });
    expect((row?.details?.withheld as { members: number }).members).toBeGreaterThan(0);
  });

  it("property: a Type is described exactly when a query of it is not refused, and an object never carries a member its description withholds", async () => {
    const roles = fc.subarray(["maintainer", "viewer", "lead", "ai-enclave", "auditor"]);
    const clearance = fc.constantFrom(undefined, "UNCLASSIFIED", "CUI", "SECRET");
    const principal = fc.record({ roles, clearance });
    const identity = fc.record({ person: principal, model: fc.option(principal, { nil: undefined }) }).map(({ person, model }): Identity => {
      const who: Identity = { subjectId: "generated", roles: person.roles, attributes: { displayName: "SSgt Rivera" }, ...(person.clearance ? { clearance: person.clearance } : {}) };
      if (!model) return who;
      const audience: Audience = { id: "model:generated", kind: "model", roles: model.roles, attributes: {}, ...(model.clearance ? { clearance: model.clearance } : {}) };
      return withAudience(who, audience);
    });
    await fc.assert(
      fc.asyncProperty(identity, async (who) => {
        const model = await tb.runtime.describeModel(who);
        expect(dangling(model)).toEqual([]);
        for (const name of AIRFORCE) {
          const items = await queried(tb.runtime, name, who);
          expect(type(model, name) !== undefined, `${name} for ${JSON.stringify(who)}`).toBe(items !== "refused");
          const allowed = members(type(model, name));
          for (const item of items === "refused" ? [] : items) for (const key of Object.keys(item)) expect(allowed.has(key), `${name}.${key}`).toBe(true);
        }
      }),
      { seed: 20261014, numRuns: 60 }
    );
  });
});

async function queried(runtime: SemanticRuntime, typeName: string, who: Identity): Promise<Record<string, unknown>[] | "refused"> {
  try {
    return (await runtime.query({ type: typeName, limit: 5 }, who)).items.map((i) => i.values);
  } catch (err) {
    if (err instanceof AuthorizationError) return "refused";
    throw err;
  }
}

describe("discovery modes (ADR-0068)", () => {
  it("open, the default, describes the whole model to anyone, as before", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    expect(tb.runtime.discovery).toBe("open");
    const forAnonymous = await tb.runtime.describeModel(anonymous);
    expect(forAnonymous.actions.map((a) => a.name)).toEqual(["CreateMaintenanceWorkOrder", "UpdateWorkOrderStatus"]);
    expect(forAnonymous).toEqual(await tb.runtime.describeModel(viewer));
  });

  it("authenticated refuses an anonymous caller and describes the whole model to anyone else", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { discovery: "authenticated" } });
    await expect(tb.runtime.describeModel(anonymous)).rejects.toThrow(AuthorizationError);
    await expect(tb.runtime.describeModel({ ...anonymous, subjectId: "" })).rejects.toThrow(AuthorizationError);
    expect((await tb.runtime.describeModel(viewer)).actions).toHaveLength(2);
  });

  it("a mode the runtime does not know is refused at construction", async () => {
    await expect(buildAirforceTestbed({ runtimeOptions: { discovery: "secret" as never } })).rejects.toThrow(TypeError);
  });

  it("HIGH_ASSURANCE_V2 requires need-to-know, and supplies it when omitted", async () => {
    const strict = { securityProfile: HIGH_ASSURANCE_V2, telemetryIdentity: "none" as const, classification: undefined };
    await expect(buildAirforceTestbed({ runtimeOptions: { ...strict, discovery: "open" } })).rejects.toThrow(SecurityProfileError);
    await expect(buildAirforceTestbed({ runtimeOptions: { ...strict, discovery: "authenticated" } })).rejects.toThrow(/discovery must be "need-to-know"/);
    const { runtime } = await buildAirforceTestbed({ runtimeOptions: strict });
    expect(runtime.discovery).toBe("need-to-know");
    expect(HIGH_ASSURANCE_V2.guarantees.at(-1)).toMatch(/^Discovery is need-to-know/);
  });
});
