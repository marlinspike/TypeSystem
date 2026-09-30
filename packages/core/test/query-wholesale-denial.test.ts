import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime, type SemanticRuntimeOptions } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { applySort } from "../src/runtime/query-ops.js";
import { DEMO_LINEAR_CLASSIFICATION } from "../src/runtime/classification.js";
import { AbacPolicyEngine, allowAllRule, anyOf, requireAttributeMatch, requireRole, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError, AuthorizationPlanError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter, SortKey } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * A query the caller can read none of is refused (ADR-0049) — when the answer would be the same for every
 * possible dataset — and is a silent page when it depends on the data. Four Types show both sides:
 *
 * - `test.Vehicle`: a role rule. An outsider's denial is wholesale.
 * - `test.Ticket`: a row-level rule (the owner, or an auditor). Whose rows a caller may read depends on the data.
 * - `test.Hollow`: the Ticket's rule over a Type that holds no rows at all, to compare against.
 * - `test.Opaque`: the Ticket's rule as a plain function, which can't plan.
 * - `test.Annex`: a SECRET Type, refused on the caller's clearance alone.
 */
const DATA: Record<string, Record<string, Record<string, unknown>>> = {
  "test.Vehicle": { v1: { id: "v1", name: "Van 1" }, v2: { id: "v2", name: "Van 2" } },
  "test.Ticket": {
    k1: { id: "k1", ownerId: "alice", title: "T-ALPHA" },
    k2: { id: "k2", ownerId: "bob", title: "T-BRAVO" }
  },
  "test.Hollow": {},
  "test.Opaque": {
    o1: { id: "o1", ownerId: "alice", title: "O-ALPHA" },
    o2: { id: "o2", ownerId: "bob", title: "O-BRAVO" }
  },
  "test.Annex": { a1: { id: "a1", body: "ANNEX-BODY" } }
};
/** Every stored value the caller must never see in a refusal. */
const SECRETS = ["T-ALPHA", "T-BRAVO", "O-ALPHA", "O-BRAVO", "ANNEX-BODY", "alice", "bob"];

class Store implements Adapter {
  readonly dataSourceId = "store-ds";
  /** Every `Type` the runtime listed or read, in order. */
  readonly calls: string[] = [];

  private rows(typeName: string) {
    return Object.entries(DATA[typeName] ?? {}).map(([objectId, values]) => ({
      objectId,
      values: { ...values },
      provenance: Object.keys(values).map((field) => ({
        propertyPath: field,
        source: { dataSourceId: this.dataSourceId, system: "store", recordId: objectId, field },
        retrievedAt: "2026-01-01T00:00:00.000Z"
      }))
    }));
  }
  async resolveProperties(typeName: string, objectId: string): Promise<ResolvedProperties> {
    this.calls.push(typeName);
    const row = this.rows(typeName).find((r) => r.objectId === objectId);
    return row ? { values: row.values, provenance: row.provenance } : { values: {}, provenance: [] };
  }
  async queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[]): Promise<AdapterQueryResult> {
    this.calls.push(typeName);
    const sorted = applySort(this.rows(typeName).filter((r) => matchesFilter(r.values, filter)), sort, (r) => r.values);
    const start = cursor ? Number(cursor) : 0;
    const end = start + (limit ?? sorted.length);
    return { items: sorted.slice(start, end), nextCursor: end < sorted.length ? String(end) : undefined };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

const dispatcher: Identity = { subjectId: "dana", roles: ["dispatcher"], attributes: {} };
/** No role, no attributes: the wholesale case. */
const outsider: Identity = { subjectId: "oscar", roles: [], attributes: {} };
const alice: Identity = { subjectId: "alice", roles: ["staff"], attributes: { userId: "alice" } };
/** Has a userId, but owns nothing: her rule is satisfiable, so whether she sees anything depends on the data. */
const carol: Identity = { subjectId: "carol", roles: ["staff"], attributes: { userId: "carol" } };
/** Staff with no userId: the rule can match nothing for them, whatever the data. */
const mallory: Identity = { subjectId: "mallory", roles: ["staff"], attributes: {} };
const secret: Identity = { subjectId: "sam", roles: [], attributes: {}, clearance: "SECRET" };
const cui: Identity = { subjectId: "cy", roles: [], attributes: {}, clearance: "CUI" };

const ticketRead = anyOf(requireRole("auditor"), requireAttributeMatch("ownerId", "userId"));
const RULES: Record<string, PolicyRule> = {
  public: allowAllRule,
  "vehicle.read": requireRole("dispatcher"),
  "ticket.read": ticketRead,
  // The same rule, decided identically, but a plain function: it cannot say what it admits (ADR-0038).
  "opaque.read": (request) => ticketRead(request)
};

async function setup(runtimeOptions: SemanticRuntimeOptions = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const register = async (name: string, schema: Omit<SemanticTypeSchema, "$id" | "type">) => {
    const short = name.split(".")[1]!;
    await registry.registerType({ $id: `https://typesys.dev/types/test/${short}/1.0.0`, type: "object", ...schema } as SemanticTypeSchema, { name, version: "1.0.0" });
    await registry.registerMapping({ id: `map-${short}`, typeName: name, target: "property", targetName: "*", dataSourceId: "store-ds", operation: "get", resolutionMode: "live" });
  };
  const strings = (names: string[]) => Object.fromEntries(names.map((n) => [n, { type: "string" }]));
  await register("test.Vehicle", { title: "Vehicle", properties: strings(["id", "name"]), "x-policy": { objectPolicy: "vehicle.read" } });
  await register("test.Ticket", { title: "Ticket", properties: strings(["id", "ownerId", "title"]), "x-policy": { objectPolicy: "ticket.read" } });
  await register("test.Hollow", { title: "Hollow", properties: strings(["id", "ownerId", "title"]), "x-policy": { objectPolicy: "ticket.read" } });
  await register("test.Opaque", { title: "Opaque", properties: strings(["id", "ownerId", "title"]), "x-policy": { objectPolicy: "opaque.read" } });
  await register("test.Annex", { title: "Annex", properties: strings(["id", "body"]), "x-policy": { objectPolicy: "public" }, "x-provenance": { defaultClassification: "SECRET" } });

  const engine = new AbacPolicyEngine();
  for (const [name, rule] of Object.entries(RULES)) engine.registerRule(name, rule);
  const store = new Store();
  const runtime = new SemanticRuntime(registry, [store], engine, { classification: DEMO_LINEAR_CLASSIFICATION, ...runtimeOptions });
  return { runtime, registry, store };
}

async function auditRows(registry: SemanticRegistry) {
  return (await registry.listAuditEvents({ limit: 1000 })).items;
}

async function failure(promise: Promise<unknown>): Promise<Error & { reason?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject");
}

const ids = (result: { items: { objectId: string }[] }) => result.items.map((i) => i.objectId).sort();

describe("A query the caller can read none of is refused (ADR-0049)", () => {
  describe("a wholesale denial is refused", () => {
    it("a read policy that admits nothing for the caller refuses the query, and the adapter is never called", async () => {
      const { runtime, store } = await setup();
      const err = await failure(runtime.query({ type: "test.Vehicle" }, outsider));

      expect(err).toBeInstanceOf(AuthorizationError);
      expect(err.message).toBe("Not authorized: read test.Vehicle");
      expect(err.reason).toBe("No object of this Type is readable by this subject");
      expect(store.calls).toEqual([]);
    });

    it("and audits exactly one deny, for the Type, naming the plan", async () => {
      const { runtime, registry } = await setup();
      await failure(runtime.query({ type: "test.Vehicle" }, outsider));

      const rows = (await auditRows(registry)).filter((e) => e.subjectId === "oscar");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ decision: "deny", operation: "query", resource: { typeName: "test.Vehicle" }, details: { control: "row-plan", plan: "never" } });
      expect(rows[0]!.resource.objectId).toBeUndefined();
    });

    it("a classified Type above the caller's clearance refuses the query, and nothing of the Type is read", async () => {
      const { runtime, store, registry } = await setup();
      const err = await failure(runtime.query({ type: "test.Annex" }, cui));

      expect(err).toBeInstanceOf(AuthorizationError);
      expect(err.message).toBe("Not authorized: read test.Annex");
      expect(err.reason).toBe("Requires a higher clearance");
      expect(store.calls).toEqual([]);
      const rows = (await auditRows(registry)).filter((e) => e.subjectId === "cy");
      expect(rows.map((e) => [e.decision, e.details?.control])).toEqual([["deny", "classification"]]);
    });

    it("a caller whose rule can match nothing for them — no userId — is refused, whatever the data", async () => {
      const { runtime } = await setup();
      expect(await failure(runtime.query({ type: "test.Ticket" }, mallory))).toBeInstanceOf(AuthorizationError);
      expect(await failure(runtime.query({ type: "test.Hollow" }, mallory))).toBeInstanceOf(AuthorizationError);
    });

    it("the callers the rule admits are not refused", async () => {
      const { runtime } = await setup();
      expect(ids(await runtime.query({ type: "test.Vehicle" }, dispatcher))).toEqual(["v1", "v2"]);
      expect(ids(await runtime.query({ type: "test.Annex" }, secret))).toEqual(["a1"]);
    });

    it("under rowSecurity require-exact, a never plan is the same plain refusal, not a plan error", async () => {
      const { runtime } = await setup({ rowSecurity: "require-exact" });
      const err = await failure(runtime.query({ type: "test.Vehicle" }, outsider));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(err).not.toBeInstanceOf(AuthorizationPlanError);
    });

    it("agrees with every other read path: getObject and aggregate refuse the same caller", async () => {
      const { runtime } = await setup();
      expect(await failure(runtime.getObject("test.Vehicle", "v1", outsider))).toBeInstanceOf(AuthorizationError);
      expect(await failure(runtime.aggregate({ type: "test.Vehicle", aggregations: [{ name: "n", op: "count" }] }, outsider))).toBeInstanceOf(AuthorizationError);
    });
  });

  describe("a denial that depends on the data stays a silent page", () => {
    it("a caller who owns no row gets an empty page, not an error", async () => {
      const { runtime } = await setup();
      const page = await runtime.query({ type: "test.Ticket" }, carol);
      expect(page.items).toEqual([]);
    });

    it("a caller sees exactly the rows they may read, and the others are dropped", async () => {
      const { runtime } = await setup();
      expect(ids(await runtime.query({ type: "test.Ticket" }, alice))).toEqual(["k1"]);
    });

    it("a rule that cannot plan, and denies everything, is an empty page: the runtime cannot tell that from denying these rows", async () => {
      const { runtime, store } = await setup();
      const page = await runtime.query({ type: "test.Opaque" }, mallory);
      expect(page.items).toEqual([]);
      expect(store.calls).toContain("test.Opaque"); // it had to read the rows to decide them
    });

    it("a filter that matches nothing, and a Type with no rows, are empty pages for an allowed caller", async () => {
      const { runtime } = await setup();
      expect((await runtime.query({ type: "test.Vehicle", filter: { property: "name", operator: "eq", value: "none" } }, dispatcher)).items).toEqual([]);
      expect((await runtime.query({ type: "test.Hollow" }, carol)).items).toEqual([]);
    });
  });

  describe("attack: using the refusal to learn what exists", () => {
    it("a Type whose rows are all hidden from the caller answers exactly like a Type with no rows", async () => {
      const { runtime } = await setup();
      const hidden = await runtime.query({ type: "test.Ticket" }, carol); // k1 and k2 exist; neither is carol's
      const empty = await runtime.query({ type: "test.Hollow" }, carol);
      expect(JSON.stringify(hidden)).toBe(JSON.stringify(empty));
    });

    it("probing with a filter that matches a hidden row answers exactly like one that matches nothing", async () => {
      const { runtime } = await setup();
      const matchesHidden = await runtime.query({ type: "test.Ticket", filter: { property: "ownerId", operator: "eq", value: "bob" } }, carol);
      const matchesNothing = await runtime.query({ type: "test.Ticket", filter: { property: "ownerId", operator: "eq", value: "nobody" } }, carol);
      expect(JSON.stringify(matchesHidden)).toBe(JSON.stringify(matchesNothing));
    });

    it("the refusal is the same whether the Type holds rows or not: it carries nothing about the data", async () => {
      const { runtime } = await setup();
      const withRows = await failure(runtime.query({ type: "test.Ticket" }, mallory));
      const withoutRows = await failure(runtime.query({ type: "test.Hollow" }, mallory));
      expect(withRows.name).toBe(withoutRows.name);
      expect(withRows.reason).toBe(withoutRows.reason);
      expect(withRows.message.replace("test.Ticket", "TYPE")).toBe(withoutRows.message.replace("test.Hollow", "TYPE"));
    });

    it("no stored value reaches a refusal, its reason, or its audit row", async () => {
      const { runtime, registry } = await setup();
      const errors = [
        await failure(runtime.query({ type: "test.Ticket" }, mallory)),
        await failure(runtime.query({ type: "test.Annex" }, cui)),
        await failure(runtime.query({ type: "test.Vehicle" }, outsider))
      ];
      const seen = JSON.stringify([errors.map((e) => [e.name, e.message, e.reason]), await auditRows(registry)]);
      for (const secretValue of SECRETS) expect(seen).not.toContain(secretValue);
    });

    it("a caller refused on one Type still reads another they are cleared for", async () => {
      const { runtime } = await setup();
      await failure(runtime.query({ type: "test.Annex" }, cui));
      expect(ids(await runtime.query({ type: "test.Ticket" }, alice))).toEqual(["k1"]);
    });
  });
});
