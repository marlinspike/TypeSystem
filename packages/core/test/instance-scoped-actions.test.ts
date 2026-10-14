import { describe, it, expect, beforeEach } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { InMemoryCache } from "../src/runtime/cache.js";
import { AbacPolicyEngine, allOf, anyOf, requireAttributeMatch, requireRole } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError, InvalidInputError, ObjectNotFoundError, PreconditionFailedError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { ActionContext } from "../src/model/context.js";
import type { QueryFilter } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";
import type { AuditEvent } from "../src/audit/audit-log.js";

/**
 * ADR-0053: an instance-scoped Action reads its target under the caller's
 * read authorization, then decides its own policy on the target's stored
 * attributes; `previewAction` decides an invocation without executing it.
 */
class TicketAdapter implements Adapter {
  readonly dataSourceId = "ds";
  readonly tickets = new Map<string, Record<string, unknown>>();
  readonly executed: { action: string; input: unknown; target?: ActionContext["target"] }[] = [];

  async resolveProperties(_typeName: string, id: string): Promise<ResolvedProperties> {
    const v = this.tickets.get(id) ?? {};
    return { values: { ...v }, provenance: [] };
  }
  async queryByType(_typeName: string, filter?: QueryFilter): Promise<AdapterQueryResult> {
    const items = [...this.tickets.entries()].map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: [] }));
    return { items: filter ? items.filter((i) => matchesFilter(i.values, filter)) : items };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(action: ActionDefinition, input: unknown, ctx: ActionContext): Promise<unknown> {
    this.executed.push({ action: action.name, input, ...(ctx.target ? { target: ctx.target } : {}) });
    const { ticketId, state } = input as { ticketId: string; state: string };
    this.tickets.set(ticketId, { ...this.tickets.get(ticketId), state });
    return { id: ticketId, state };
  }
}

const Resolve: ActionDefinition = {
  id: "a-resolve",
  name: "ResolveTicket",
  description: "Resolve one ticket.",
  applicableTypes: ["ops.Ticket"],
  target: { idFrom: "ticketId" },
  inputSchema: {
    type: "object",
    properties: { ticketId: { type: "string" }, state: { type: "string", enum: ["resolved", "open"] } },
    required: ["ticketId", "state"],
    additionalProperties: false
  },
  outputSchema: { type: "object" },
  authorizationPolicy: "ops.owner-or-lead",
  preconditions: [{ description: "The ticket is not locked", check: async (ctx) => (await ctx.getProperty("locked")) !== true }],
  implementation: { dataSourceId: "ds", operation: "resolve" },
  sideEffects: "mutates",
  idempotency: "natural",
  auditRequired: true,
  version: "1.0.0"
};

const ann: Identity = { subjectId: "ann", roles: ["agent"], attributes: { team: "red" } };
const bob: Identity = { subjectId: "bob", roles: ["agent"], attributes: { team: "blue" } };
const lead: Identity = { subjectId: "lea", roles: ["agent", "lead"], attributes: { team: "green" } };
const outsider: Identity = { subjectId: "out", roles: [], attributes: { team: "red" } };

let runtime: SemanticRuntime;
let adapter: TicketAdapter;
let store: InMemoryRegistryStore;

async function auditRows(): Promise<AuditEvent[]> {
  return (await store.listAuditEvents({ limit: 1000 })).items;
}

beforeEach(async () => {
  store = new InMemoryRegistryStore();
  const registry = new SemanticRegistry(store);
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/ops/Ticket/1.0.0",
      title: "Ticket",
      type: "object",
      properties: { team: { type: "string" }, state: { type: "string" }, locked: { type: "boolean" } },
      "x-actions": { actions: ["ResolveTicket"] },
      "x-policy": { objectPolicy: "ops.agents" }
    },
    { name: "ops.Ticket", version: "1.0.0" }
  );
  await registry.registerMapping({ id: "m", typeName: "ops.Ticket", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  await registry.registerAction(Resolve);

  const policy = new AbacPolicyEngine();
  policy.registerRule("ops.agents", requireRole("agent"));
  policy.registerRule("ops.owner-or-lead", allOf(requireRole("agent"), anyOf(requireRole("lead"), requireAttributeMatch("team", "team"))));

  adapter = new TicketAdapter();
  adapter.tickets.set("T1", { team: "red", state: "open" });
  adapter.tickets.set("T2", { team: "blue", state: "open", locked: true });
  runtime = new SemanticRuntime(registry, [adapter], policy);
});

describe("Instance-scoped Actions (ADR-0053)", () => {
  it("decides the Action's policy on the target object's own attributes", async () => {
    await expect(runtime.invokeAction("ResolveTicket", { ticketId: "T1", state: "resolved" }, ann)).resolves.toEqual({ id: "T1", state: "resolved" });
    await expect(runtime.invokeAction("ResolveTicket", { ticketId: "T1", state: "open" }, bob)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(runtime.invokeAction("ResolveTicket", { ticketId: "T1", state: "open" }, lead)).resolves.toBeDefined();
    expect(adapter.executed.map((e) => [e.input, e.target])).toEqual([
      [{ ticketId: "T1", state: "resolved" }, { typeName: "ops.Ticket", objectId: "T1" }],
      [{ ticketId: "T1", state: "open" }, { typeName: "ops.Ticket", objectId: "T1" }]
    ]);
  });

  it("refuses a target the caller may not read before deciding anything else, and audits it", async () => {
    await expect(runtime.invokeAction("ResolveTicket", { ticketId: "T1", state: "resolved" }, outsider)).rejects.toBeInstanceOf(AuthorizationError);
    expect(adapter.executed).toEqual([]);
    const rows = (await auditRows()).filter((r) => r.subjectId === "out");
    expect(rows).toEqual([expect.objectContaining({ operation: "invokeAction", action: "read", decision: "deny", resource: expect.objectContaining({ objectId: "T1" }) as unknown })]);
  });

  it("tells a caller who may read the Type that a missing target is missing, and one who may not nothing", async () => {
    await expect(runtime.invokeAction("ResolveTicket", { ticketId: "NOPE", state: "resolved" }, ann)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(runtime.invokeAction("ResolveTicket", { ticketId: "NOPE", state: "resolved" }, outsider)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("decides an input naming no target per Type, where the attribute rule denies, and audits the attempt", async () => {
    await expect(runtime.invokeAction("ResolveTicket", { state: "resolved" }, ann)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(runtime.invokeAction("ResolveTicket", { ticketId: 7, state: "resolved" }, ann)).rejects.toBeInstanceOf(AuthorizationError);
    // A lead passes the type-level rule, so the missing id is then an input error.
    await expect(runtime.invokeAction("ResolveTicket", { state: "resolved" }, lead)).rejects.toBeInstanceOf(InvalidInputError);
    const denies = (await auditRows()).filter((r) => r.subjectId === "ann" && r.decision === "deny");
    expect(denies).toHaveLength(2);
    expect(denies.every((r) => r.resource.objectId === undefined && r.action === "ResolveTicket")).toBe(true);
  });

  it("gives preconditions the target's stored values through getProperty", async () => {
    await expect(runtime.invokeAction("ResolveTicket", { ticketId: "T2", state: "resolved" }, bob)).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(adapter.executed).toEqual([]);
  });

  it("names the target in the success audit row", async () => {
    await runtime.invokeAction("ResolveTicket", { ticketId: "T1", state: "resolved" }, ann);
    const success = (await auditRows()).find((r) => r.outcome === "success");
    expect(success).toMatchObject({ action: "ResolveTicket", resource: { typeName: "ops.Ticket", objectId: "T1" } });
  });

  it("drops a cached copy of the target after acting on it", async () => {
    const cachedStore = new InMemoryRegistryStore();
    const registry = new SemanticRegistry(cachedStore);
    for (const t of await store.listTypes()) await cachedStore.putType(t);
    await registry.registerMapping({ id: "m", typeName: "ops.Ticket", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "cached", cacheTtlMs: 60_000 });
    await registry.registerAction(Resolve);
    const policy = new AbacPolicyEngine();
    policy.registerRule("ops.agents", requireRole("agent"));
    policy.registerRule("ops.owner-or-lead", requireRole("agent"));
    const cached = new SemanticRuntime(registry, [adapter], policy, { cache: new InMemoryCache() });
    expect((await cached.getObject("ops.Ticket", "T1", ann)).values.state).toBe("open");
    await cached.invokeAction("ResolveTicket", { ticketId: "T1", state: "resolved" }, ann);
    expect((await cached.getObject("ops.Ticket", "T1", ann)).values.state).toBe("resolved");
  });

  it("lists instance-scoped Actions per object when given one, and per Type otherwise", async () => {
    expect((await runtime.listActions("ops.Ticket", ann)).map((a) => [a.action.name, a.authorized, a.instanceScoped])).toEqual([["ResolveTicket", false, true]]);
    expect((await runtime.listActions("ops.Ticket", ann, { objectId: "T1" }))[0]!.authorized).toBe(true);
    expect((await runtime.listActions("ops.Ticket", ann, { objectId: "T2" }))[0]!.authorized).toBe(false);
    expect((await runtime.listActions("ops.Ticket", lead))[0]!.authorized).toBe(true);
  });

  it("refuses at registration a target outside applicableTypes, or an id property that isn't a required string", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await expect(registry.registerAction({ ...Resolve, target: { idFrom: "ticketId", type: "ops.Other" } })).rejects.toThrow(/not one of its applicableTypes/);
    await expect(registry.registerAction({ ...Resolve, target: { idFrom: "state" }, inputSchema: { ...Resolve.inputSchema, required: ["ticketId"] } })).rejects.toThrow(/required string property/);
    await expect(
      registry.registerAction({ ...Resolve, inputSchema: { type: "object", properties: { ticketId: { type: "number" } }, required: ["ticketId"] } })
    ).rejects.toThrow(/required string property/);
  });
});

describe("previewAction (ADR-0053)", () => {
  it("reports a call that would run, and runs nothing", async () => {
    const preview = await runtime.previewAction("ResolveTicket", { ticketId: "T1", state: "resolved" }, ann);
    expect(preview).toEqual({
      action: "ResolveTicket",
      version: "1.0.0",
      target: { typeName: "ops.Ticket", objectId: "T1" },
      authorized: true,
      inputValid: true,
      preconditions: [{ description: "The ticket is not locked", satisfied: true }],
      blockers: [],
      wouldExecute: true,
      effects: { sideEffects: "mutates", idempotency: "natural", auditRequired: true }
    });
    expect(adapter.executed).toEqual([]);
    expect(adapter.tickets.get("T1")!.state).toBe("open");
  });

  it("names each blocker in the order the runtime checks, and decides nothing past the first gate that fails", async () => {
    const unauthorized = await runtime.previewAction("ResolveTicket", { ticketId: "T1", state: "bogus" }, bob);
    expect(unauthorized).toMatchObject({ authorized: false, inputValid: null, wouldExecute: false, preconditions: [{ satisfied: null }] });
    expect(unauthorized.blockers.map((b) => b.kind)).toEqual(["authorization"]);

    const badInput = await runtime.previewAction("ResolveTicket", { ticketId: "T1", state: "bogus" }, ann);
    expect(badInput).toMatchObject({ authorized: true, inputValid: false, preconditions: [{ satisfied: null }] });
    expect(badInput.blockers).toEqual([{ kind: "input", message: expect.stringContaining("state") as string }]);

    const locked = await runtime.previewAction("ResolveTicket", { ticketId: "T2", state: "resolved" }, bob);
    expect(locked).toMatchObject({ authorized: true, inputValid: true, preconditions: [{ satisfied: false }], wouldExecute: false });
    expect(locked.blockers).toEqual([{ kind: "precondition", message: "Precondition failed: The ticket is not locked" }]);

    const missing = await runtime.previewAction("ResolveTicket", { ticketId: "NOPE", state: "resolved" }, ann);
    expect(missing.blockers.map((b) => b.kind)).toEqual(["target"]);
    expect(adapter.executed).toEqual([]);
  });

  it("reports a precondition that throws as unsatisfied rather than failing the preview", async () => {
    adapter.tickets.set("T3", { team: "red", state: "open" });
    const original = Resolve.preconditions![0]!.check;
    Resolve.preconditions![0]!.check = async () => {
      throw new Error("backend down");
    };
    try {
      const preview = await runtime.previewAction("ResolveTicket", { ticketId: "T3", state: "resolved" }, ann);
      expect(preview.preconditions).toEqual([{ description: "The ticket is not locked", satisfied: false }]);
    } finally {
      Resolve.preconditions![0]!.check = original;
    }
  });

  it("audits every decision it makes under previewAction, plus its outcome", async () => {
    await runtime.previewAction("ResolveTicket", { ticketId: "T1", state: "resolved" }, ann);
    await runtime.previewAction("ResolveTicket", { ticketId: "T1", state: "resolved" }, bob);
    const rows = await auditRows();
    expect(rows.every((r) => r.operation === "previewAction")).toBe(true);
    const outcomes = rows.filter((r) => r.details?.control === "preview");
    expect(outcomes.map((r) => [r.subjectId, r.decision, r.details?.blockers]).sort()).toEqual([
      ["ann", "allow", []],
      ["bob", "deny", ["authorization"]]
    ]);
  });
});

describe("Instance-scoped Action preconditions over a value the caller may not read (ADR-0053)", () => {
  async function lockedIsLeadsOnly() {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registry.registerType(
      {
        $id: "https://typesys.dev/types/ops/Ticket/1.0.0",
        title: "Ticket",
        type: "object",
        properties: { team: { type: "string" }, state: { type: "string" }, locked: { type: "boolean" } },
        "x-actions": { actions: ["ResolveTicket"] },
        "x-policy": { objectPolicy: "ops.agents", propertyPolicies: { locked: "ops.leads" } }
      },
      { name: "ops.Ticket", version: "1.0.0" }
    );
    await registry.registerMapping({ id: "m", typeName: "ops.Ticket", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
    await registry.registerAction(Resolve);
    const policy = new AbacPolicyEngine();
    policy.registerRule("ops.agents", requireRole("agent"));
    policy.registerRule("ops.leads", requireRole("lead"));
    policy.registerRule("ops.owner-or-lead", allOf(requireRole("agent"), anyOf(requireRole("lead"), requireAttributeMatch("team", "team"))));
    const tickets = new TicketAdapter();
    tickets.tickets.set("L1", { team: "red", state: "open", locked: true });
    tickets.tickets.set("U1", { team: "red", state: "open" });
    return { rt: new SemanticRuntime(registry, [tickets], policy), tickets };
  }

  it("is not decided for that caller: the preview says so and the invocation is refused, whatever the value", async () => {
    const { rt, tickets } = await lockedIsLeadsOnly();
    for (const ticketId of ["L1", "U1"]) {
      const preview = await rt.previewAction("ResolveTicket", { ticketId, state: "resolved" }, ann);
      expect(preview.preconditions).toEqual([{ description: "The ticket is not locked", satisfied: null }]);
      expect(preview.blockers.map((b) => b.kind)).toEqual(["precondition"]);
      await expect(rt.invokeAction("ResolveTicket", { ticketId, state: "resolved" }, ann)).rejects.toThrow(
        'Precondition failed for action "ResolveTicket": The ticket is not locked (it reads a value the caller may not read)'
      );
    }
    expect(tickets.executed).toEqual([]);
    // A caller who may read the value is decided on it, as before.
    const redLead: Identity = { ...lead, attributes: { team: "red" } };
    await expect(rt.invokeAction("ResolveTicket", { ticketId: "L1", state: "resolved" }, redLead)).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(rt.invokeAction("ResolveTicket", { ticketId: "U1", state: "resolved" }, redLead)).resolves.toEqual({ id: "U1", state: "resolved" });
  });
});
