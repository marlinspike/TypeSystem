import { describe, expect, it } from "vitest";
import { AuthorizationError, InMemoryRateLimiter, NotFoundError, requireRole, withAudience, type Identity, type SemanticRuntimeOptions } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities } from "../src/setup.js";
import { MAINTENANCE_DATA_SOURCE_ID } from "../src/data-source-ids.js";

const AIRCRAFT = { kind: "read", type: "airforce.Aircraft", id: "AF86-0147" } as const;
/** Values only a maintainer reads: no explanation for anyone may contain them. */
const SECRETS = ["degraded", "FOB ALPHA", "PMC"];

async function testbed(inspectors: string[] = ["lead"], runtimeOptions: SemanticRuntimeOptions = {}) {
  const tb = await buildAirforceTestbed({ runtimeOptions: { inspection: { policy: "typesys.inspect" }, ...runtimeOptions } });
  (tb.policyEngine as unknown as { registerRule(n: string, r: unknown): void }).registerRule("typesys.inspect", requireRole(...inspectors));
  return tb;
}

describe("inspection (ADR-0088)", () => {
  it("shows an inspector where each Aircraft value comes from and what guards it", async () => {
    const { runtime } = await testbed();
    const i = await runtime.inspectModel(demoIdentities.lead, { types: ["airforce.Aircraft"] });
    const aircraft = i.types[0]!;
    const member = (n: string) => aircraft.members.find((m) => m.name === n)!;
    expect(aircraft.objectPolicy).toBe("airforce.read-aircraft");
    expect(member("maintenanceStatus")).toMatchObject({ kind: "stored", origin: { from: "trait", name: "Maintainable" }, policy: "airforce.maintainer-only", source: { dataSourceId: "in-memory-airforce-repo", override: false } });
    expect(member("id").origin).toEqual({ from: "base", type: "core.Asset" });
    expect(member("deploymentLocation").markings).toEqual(["SECRET"]);
    expect(member("readinessStatus").computed).toMatchObject({ dependsOn: ["maintenanceStatus"], releases: [], reads: "undeclared" });
    expect(member("needsAttention").computed).toMatchObject({ releases: ["maintenanceStatus"], reads: [MAINTENANCE_DATA_SOURCE_ID] });
    expect(aircraft.relationships.find((r) => r.name === "maintenance")).toMatchObject({ crossSource: true, source: { dataSourceId: MAINTENANCE_DATA_SOURCE_ID } });
    expect(i.policies.find((p) => p.name === "airforce.maintainer-only")).toEqual({ name: "airforce.maintainer-only", rule: "role in [maintainer, ai-enclave]", opaque: false, decides: ["airforce.Aircraft.maintenanceStatus"] });
    expect(i.sources.map((s) => s.id)).toEqual(["in-memory-airforce-repo", "mock-remis-rest"]);
    expect(i.modelDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("describes an Action's contract, policy, preconditions and the source it writes to", async () => {
    const { runtime } = await testbed();
    const i = await runtime.inspectModel(demoIdentities.lead);
    const create = i.actions.find((a) => a.name === "CreateMaintenanceWorkOrder")!;
    expect(create).toMatchObject({ sideEffects: "creates", implementation: { dataSourceId: MAINTENANCE_DATA_SOURCE_ID } });
    expect(create.preconditions.map((p) => p.description)).toContain("The referenced maintenance event must exist");
  });

  it("is refused to everyone when no inspection policy is configured, and to anyone the policy does not admit", async () => {
    const plain = await buildAirforceTestbed();
    await expect(plain.runtime.inspectModel(demoIdentities.lead)).rejects.toBeInstanceOf(AuthorizationError);
    const { runtime, registry } = await testbed();
    await expect(runtime.inspectModel(demoIdentities.viewer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(runtime.inspectModel(demoIdentities.anonymous)).rejects.toBeInstanceOf(AuthorizationError);
    const rows = (await registry.listAuditEvents({ limit: 10 })).items.filter((r) => r.operation === "inspectModel");
    expect(rows.every((r) => r.decision === "deny")).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("never describes more than the inspector's own need-to-know discovery does", async () => {
    const { runtime } = await testbed(["viewer"], { discovery: "need-to-know" });
    const i = await runtime.inspectModel(demoIdentities.viewer);
    const aircraft = i.types.find((t) => t.name === "airforce.Aircraft")!;
    const names = aircraft.members.map((m) => m.name);
    expect(names).not.toContain("maintenanceStatus");
    expect(names).not.toContain("readinessStatus");
    expect(names).not.toContain("deploymentLocation");
    expect(i.policies.map((p) => p.name)).not.toContain("airforce.maintainer-only");
    expect(i.narrowed).toBe(true);
    expect(JSON.stringify(i)).not.toContain("maintenanceStatus");
  });

  it("names a marking only to an inspector cleared for it", async () => {
    const { runtime } = await testbed(["viewer"]);
    const i = await runtime.inspectModel(demoIdentities.viewer, { types: ["airforce.Aircraft"] });
    const location = i.types[0]!.members.find((m) => m.name === "deploymentLocation")!;
    expect(location.markings).toEqual([]);
    expect(location.withheldMarkings).toBe(1);
    expect(JSON.stringify(i)).not.toContain("SECRET\"");
  });

  it("refuses an undeclared source a computed value asks for when it declares its reads", async () => {
    const { runtime, registry } = await testbed();
    const def = (await registry.getType("airforce.Aircraft"))!;
    const needs = def.computedProperties.find((c) => c.name === "needsAttention")!;
    needs.reads = ["in-memory-airforce-repo"];
    // AF86-0212 is operational, so the computation reaches for the maintenance system and is refused.
    await expect(runtime.getObject("airforce.Aircraft", "AF86-0212", demoIdentities.maintainer)).rejects.toThrow(/reads data source "mock-remis-rest", which its reads do not declare/);
  });
});

describe("explanations (ADR-0089)", () => {
  it("tells an inspector why the viewer cannot see maintenanceStatus, deploymentLocation or readinessStatus, and never the values", async () => {
    const { runtime } = await testbed();
    const e = await runtime.explain(AIRCRAFT, demoIdentities.lead, { as: demoIdentities.viewer });
    const f = (m: string) => e.findings.find((x) => x.member === m)!;
    expect(e).toMatchObject({ outcome: "partial", disclosure: "inspector", subject: "user-viewer-1" });
    expect(f("maintenanceStatus")).toMatchObject({ outcome: "withheld", control: "member-policy", policy: "airforce.maintainer-only", rule: "role in [maintainer, ai-enclave]" });
    expect(f("deploymentLocation")).toMatchObject({ outcome: "withheld", control: "classification", markings: ["SECRET"] });
    expect(f("readinessStatus")).toMatchObject({ outcome: "withheld", control: "derivation", inputs: ["maintenanceStatus"] });
    expect(f("needsAttention")).toMatchObject({ outcome: "returned", control: "release", inputs: ["maintenanceStatus"] });
    expect(f("tailNumber").outcome).toBe("returned");
    for (const secret of SECRETS) expect(JSON.stringify(e)).not.toContain(secret);
  });

  it("tells a caller about their own access only what a refusal would: no policy names, rules or markings", async () => {
    const { runtime } = await testbed();
    const e = await runtime.explain(AIRCRAFT, demoIdentities.viewer);
    expect(e.disclosure).toBe("caller");
    const text = JSON.stringify(e);
    expect(text).not.toContain("airforce.maintainer-only");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("role in");
    expect(e.findings.find((x) => x.member === "maintenanceStatus")).toEqual({ about: "airforce.Aircraft/AF86-0147.maintenanceStatus", member: "maintenanceStatus", outcome: "withheld", basis: "evaluated", control: "member-policy" });
  });

  it("under need-to-know does not even say which control withheld a caller's value", async () => {
    const { runtime } = await testbed(["lead"], { discovery: "need-to-know" });
    const e = await runtime.explain(AIRCRAFT, demoIdentities.viewer);
    expect(e.findings.some((f) => f.member === "maintenanceStatus")).toBe(false);
    expect(e.findings.every((f) => f.control === undefined)).toBe(true);
  });

  it("refuses to explain another subject's access to anyone the inspection policy does not admit", async () => {
    const { runtime } = await testbed();
    await expect(runtime.explain(AIRCRAFT, demoIdentities.viewer, { as: demoIdentities.maintainer })).rejects.toBeInstanceOf(AuthorizationError);
    const plain = await buildAirforceTestbed();
    await expect(plain.runtime.explain(AIRCRAFT, demoIdentities.lead, { as: demoIdentities.viewer })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses an inspector who may not read the object themselves, as their own read would", async () => {
    const { runtime } = await testbed(["auditor"]);
    const auditor: Identity = { subjectId: "auditor-1", roles: ["auditor"], attributes: {} };
    await expect(runtime.explain(AIRCRAFT, auditor, { as: demoIdentities.viewer })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("answers a Type the investigator may not learn of as unknown", async () => {
    const { runtime } = await testbed(["viewer"], { discovery: "need-to-know" });
    await expect(runtime.explain({ kind: "read", type: "airforce.Nope", id: "x" }, demoIdentities.viewer, { as: demoIdentities.maintainer })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("attributes a refusal to the model audience when the person may read it and the model may not", async () => {
    const { runtime } = await testbed();
    const e = await runtime.explain(AIRCRAFT, demoIdentities.lead, { as: withAudience(demoIdentities.maintainer, demoAudiences.enclaveModel) });
    expect(e.audience).toBe(demoAudiences.enclaveModel.id);
    expect(e.findings.find((f) => f.member === "deploymentLocation")).toMatchObject({ outcome: "withheld", control: "audience" });
    expect(e.findings.find((f) => f.member === "maintenanceStatus")?.outcome).toBe("returned");
  });

  it("explains a refused Action with its policy, rule and declared effects, executing nothing", async () => {
    const { runtime } = await testbed();
    const wo = (await runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9001", assignedTo: "MSgt Okafor" }, demoIdentities.lead)) as { id: string };
    const status = async () => (await runtime.getObject("airforce.WorkOrder", wo.id, demoIdentities.lead)).values.status;
    expect(await status()).toBe("open");
    const e = await runtime.explain({ kind: "invoke", action: "UpdateWorkOrderStatus", input: { workOrderId: wo.id, status: "closed" } }, demoIdentities.lead, { as: demoIdentities.maintainer });
    expect(e.outcome).toBe("refused");
    expect(e.findings[0]).toMatchObject({ control: "action-policy", policy: "airforce.work-order-assignee", rule: "all of (role in [maintainer]; any of (role in [lead]; resource.assignedTo = subject.displayName))" });
    expect(e.effects).toEqual({ sideEffects: "mutates", idempotency: "natural", auditRequired: true, source: MAINTENANCE_DATA_SOURCE_ID });
    const allowed = await runtime.explain({ kind: "invoke", action: "UpdateWorkOrderStatus", input: { workOrderId: wo.id, status: "closed" } }, demoIdentities.lead);
    expect(allowed.outcome).toBe("allowed");
    expect(await status()).toBe("open");
  });

  it("explains a query refused outright by the object policy's plan", async () => {
    const { runtime } = await testbed();
    const e = await runtime.explain({ kind: "query", query: { type: "airforce.Aircraft", limit: 5 } }, demoIdentities.lead, { as: demoIdentities.anonymous });
    expect(e.outcome).toBe("refused");
    expect(e.findings[0]).toMatchObject({ control: "row-plan", policy: "airforce.read-aircraft", rule: "role in [maintainer, viewer, ai-enclave]" });
  });

  it("reports an invalid query as invalid", async () => {
    const { runtime } = await testbed();
    const e = await runtime.explain({ kind: "query", query: { type: "airforce.Aircraft", limit: -1 } }, demoIdentities.lead);
    expect(e.outcome).toBe("invalid");
  });

  it("names a source that failed during the explained read, to an inspector", async () => {
    const { runtime, mockRestAdapter } = await testbed();
    const original = mockRestAdapter.queryByType.bind(mockRestAdapter);
    mockRestAdapter.queryByType = async () => {
      const { AdapterUnavailableError } = await import("@typesys/core");
      throw new AdapterUnavailableError("maintenance system down");
    };
    try {
      const e = await runtime.explain({ kind: "read", type: "airforce.Aircraft", id: "AF86-0212" }, demoIdentities.lead, { as: demoIdentities.maintainer });
      expect(e.outcome).toBe("unavailable");
      expect(e.findings[0]).toMatchObject({ control: "source", source: MAINTENANCE_DATA_SOURCE_ID });
    } finally {
      mockRestAdapter.queryByType = original;
    }
  });

  it("marks the subject's audit rows as made during an explanation, and does not charge the subject's rate limit", async () => {
    const { runtime, registry } = await testbed(["lead"], { rateLimiter: new InMemoryRateLimiter({ capacity: 2, refillPerSecond: 0 }) });
    await runtime.explain(AIRCRAFT, demoIdentities.lead, { as: demoIdentities.viewer });
    const rows = (await registry.listAuditEvents({ limit: 100 })).items.filter((r) => r.subjectId === "user-viewer-1");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.operation === "explain" && r.details?.explainedBy === "user-lead-1")).toBe(true);
    // The viewer's two requests are still theirs.
    await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.viewer);
    await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.viewer);
  });

  it("lists an inspector's earlier decisions about the subject from the audit log, never the explanation's own", async () => {
    const { runtime } = await testbed();
    await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.viewer);
    const e = await runtime.explain(AIRCRAFT, demoIdentities.lead, { as: demoIdentities.viewer });
    expect(e.observed.length).toBeGreaterThan(0);
    expect(e.observed.every((o) => o.operation === "getObject")).toBe(true);
    expect(e.observed.some((o) => o.member === "maintenanceStatus" && o.decision === "deny")).toBe(true);
  });
});
