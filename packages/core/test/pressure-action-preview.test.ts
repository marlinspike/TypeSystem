import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, requireRole } from "../src/policy/abac-policy-engine.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { Identity } from "../src/model/policy.js";

/**
 * Adversarial probes of ADR-0053. An instance-scoped Action's
 * `ctx.getProperty` is documented as reading the target's "already-authorized
 * stored values"; previewAction then discloses each precondition's result.
 */
class Store implements Adapter {
  readonly dataSourceId = "ds";
  readonly rows = new Map<string, Record<string, unknown>>([["T1", { team: "red", state: "open", salary: 250000 }]]);
  executed = 0;
  async resolveProperties(_t: string, id: string): Promise<ResolvedProperties> {
    return { values: { ...(this.rows.get(id) ?? {}) }, provenance: [] };
  }
  async queryByType(): Promise<AdapterQueryResult> {
    return { items: [...this.rows].map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: [] })) };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    this.executed++;
    return {};
  }
}

const seen: unknown[] = [];
const Close: ActionDefinition = {
  id: "a-close",
  name: "CloseTicket",
  description: "Close one ticket.",
  applicableTypes: ["ops.Ticket"],
  target: { idFrom: "ticketId" },
  inputSchema: { type: "object", properties: { ticketId: { type: "string" } }, required: ["ticketId"], additionalProperties: false },
  outputSchema: { type: "object" },
  authorizationPolicy: "ops.agents",
  // An innocuous-looking business rule over a field the caller may not read.
  preconditions: [{ description: "Only low-cost tickets may be closed", check: async (ctx) => { const v = await ctx.getProperty("salary"); seen.push(v); return (v as number) < 200000; } }],
  implementation: { dataSourceId: "ds", operation: "close" },
  sideEffects: "mutates",
  idempotency: "natural",
  auditRequired: true,
  version: "1.0.0"
};

const ann: Identity = { subjectId: "ann", roles: ["agent"], attributes: {} };

async function setup() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/ops/Ticket/1.0.0",
      title: "Ticket",
      type: "object",
      properties: { team: { type: "string" }, state: { type: "string" }, salary: { type: "number" } },
      "x-actions": { actions: ["CloseTicket"] },
      "x-policy": { objectPolicy: "ops.agents", propertyPolicies: { salary: "ops.hr" } }
    },
    { name: "ops.Ticket", version: "1.0.0" }
  );
  await registry.registerMapping({ id: "m", typeName: "ops.Ticket", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  await registry.registerAction(Close);
  const policy = new AbacPolicyEngine();
  policy.registerRule("ops.agents", requireRole("agent"));
  policy.registerRule("ops.hr", requireRole("hr"));
  const adapter = new Store();
  return { runtime: new SemanticRuntime(registry, [adapter], policy), adapter };
}

describe("ADR-0053 getProperty / preview over member-restricted values", () => {
  it("does not hand a caller's precondition (and the preview's per-precondition answer) a value the caller may not read", async () => {
    const { runtime, adapter } = await setup();
    // ann may read the ticket, but not its salary.
    const obj = await runtime.getObject("ops.Ticket", "T1", ann);
    expect(obj.values).not.toHaveProperty("salary");

    seen.length = 0;
    const preview = await runtime.previewAction("CloseTicket", { ticketId: "T1" }, ann);
    expect(adapter.executed).toBe(0);
    // Observed: the precondition saw 250000, and the preview tells ann "satisfied: false" -- one bit of salary per call,
    // repeatable, side-effect free. Expected: getProperty withholds values the caller's read would withhold.
    expect(seen).not.toContain(250000);
    expect(preview.preconditions[0]!.satisfied).not.toBe(false);
  });
});
