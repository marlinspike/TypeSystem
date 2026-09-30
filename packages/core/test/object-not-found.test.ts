import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { applySort } from "../src/runtime/query-ops.js";
import { parseResolution } from "../src/runtime/resolution.js";
import { AbacPolicyEngine, allowAllRule, requireAttributeMatch, requireRole, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError, NotFoundError, ObjectNotFoundError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { QueryFilter, SortKey } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * A missing object is not found (ADR-0048). A fleet: Vehicles (role-level rule), each with one Driver and many
 * Trips (public), and Tickets (row-level rule: the owner reads it). Some records are deliberately absent — a
 * Vehicle's driver, a Trip the Vehicle still lists — so every read path meets an id that nothing holds.
 */
const DATA: Record<string, Record<string, Record<string, unknown>>> = {
  "test.Vehicle": {
    v1: { id: "v1", name: "Van 1", driverId: "d1" },
    v2: { id: "v2", name: "Van 2", driverId: "d-gone" },
    v3: { id: "v3", name: "Van 3", driverId: "d1" }
  },
  "test.Driver": { d1: { id: "d1", name: "Dana" } },
  "test.Trip": {
    t1: { id: "t1", vehicleId: "v1", route: "north" },
    t2: { id: "t2", vehicleId: "v1", route: "south" },
    "t-peek": { id: "t-peek", vehicleId: "v3", route: "east" },
    "t-boom": { id: "t-boom", vehicleId: "v4", route: "west" }
  },
  "test.Ticket": {
    k1: { id: "k1", ownerId: "alice", title: "T-ALPHA" },
    k2: { id: "k2", ownerId: "bob", title: "T-BRAVO" }
  }
};
const WARRANTIES: Record<string, Record<string, unknown>> = { "v-ovr": { warranty: "active" } };
/** Every stored value of a Ticket the caller must never see. */
const TICKET_SECRETS = ["T-ALPHA", "T-BRAVO", "bob"];

class FleetAdapter implements Adapter {
  readonly dataSourceId = "fleet-ds";
  /** Trip ids the relationship index lists for v1 although no Trip record exists. */
  staleTripRefs: string[] = [];

  private prov(objectId: string, values: Record<string, unknown>) {
    return Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: this.dataSourceId, system: "fleet", recordId: objectId, field },
      retrievedAt: "2026-01-01T00:00:00.000Z"
    }));
  }
  async resolveProperties(typeName: string, objectId: string): Promise<ResolvedProperties> {
    if (objectId === "t-boom") throw new Error("the fleet database is on fire");
    const values = DATA[typeName]?.[objectId] ?? {};
    return { values: { ...values }, provenance: this.prov(objectId, values) };
  }
  async queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[]): Promise<AdapterQueryResult> {
    const rows = Object.entries(DATA[typeName] ?? {}).map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: this.prov(objectId, values) }));
    const sorted = applySort(rows.filter((r) => matchesFilter(r.values, filter)), sort, (r) => r.values);
    const start = cursor ? Number(cursor) : 0;
    const end = start + (limit ?? sorted.length);
    return { items: sorted.slice(start, end), nextCursor: end < sorted.length ? String(end) : undefined };
  }
  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string): Promise<RelatedRef[]> {
    const strategy = parseResolution(relationship.resolution.operation);
    if (strategy.kind === "byOwnField") {
      const target = DATA[relationship.sourceType]?.[sourceObjectId]?.[strategy.field];
      return typeof target === "string" ? [{ objectId: target }] : [];
    }
    if (strategy.kind !== "byForeignKey") throw new Error(`unsupported ${strategy.kind}`);
    const found = Object.entries(DATA[relationship.targetType] ?? {})
      .filter(([, v]) => v[strategy.field] === sourceObjectId)
      .map(([objectId]) => ({ objectId }));
    return sourceObjectId === "v1" ? [...found, ...this.staleTripRefs.map((objectId) => ({ objectId }))] : found;
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

/** The one source of `warranty` for a Vehicle — it also holds a record (`v-ovr`) that the fleet database doesn't. */
class WarrantyAdapter implements Adapter {
  readonly dataSourceId = "warranty-ds";
  async resolveProperties(_typeName: string, objectId: string): Promise<ResolvedProperties> {
    const values = WARRANTIES[objectId] ?? {};
    return {
      values: { ...values },
      provenance: Object.keys(values).map((f) => ({ propertyPath: f, source: { dataSourceId: this.dataSourceId, system: "warranty", recordId: objectId, field: f }, retrievedAt: "2026-01-01T00:00:00.000Z" }))
    };
  }
  async queryByType(): Promise<AdapterQueryResult> {
    return { items: [] };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

const dispatcher: Identity = { subjectId: "dana", roles: ["dispatcher"], attributes: {} };
/** A caller no rule admits: no role, no attributes. */
const outsider: Identity = { subjectId: "oscar", roles: [], attributes: {} };
const alice: Identity = { subjectId: "alice", roles: ["staff"], attributes: { userId: "alice" } };

const RULES: Record<string, PolicyRule> = {
  public: allowAllRule,
  "vehicle.read": requireRole("dispatcher"),
  "ticket.read": requireAttributeMatch("ownerId", "userId"),
  /** Allows anyone except the owner "bob" — so it allows an object that has no attributes at all. */
  "ticket.deny-bob": (request) => ({ allow: request.resource.attributes?.ownerId !== "bob" })
};

async function setup(opts: { rules?: Record<string, PolicyRule>; ticketPolicy?: string } = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const headlineCalls: string[] = [];
  const runtimeRef: { current?: SemanticRuntime } = {};

  const register = async (name: string, schema: Omit<SemanticTypeSchema, "$id" | "type">, computedImplementations: Record<string, (ctx: { objectId: string; getProperty: (n: string) => Promise<unknown> }) => Promise<unknown>> = {}) => {
    const short = name.split(".")[1]!;
    await registry.registerType({ $id: `https://typesys.dev/types/test/${short}/1.0.0`, type: "object", ...schema } as SemanticTypeSchema, {
      name,
      version: "1.0.0",
      computedImplementations
    });
    await registry.registerMapping({ id: `map-${short}`, typeName: name, target: "property", targetName: "*", dataSourceId: "fleet-ds", operation: "get", resolutionMode: "live" });
  };

  await register(
    "test.Vehicle",
    {
      title: "Vehicle",
      properties: { id: { type: "string" }, name: { type: "string" }, driverId: { type: "string" }, warranty: { type: "string" } },
      "x-relationships": {
        driver: { target: "test.Driver", cardinality: "one-to-one", resolution: { dataSourceId: "fleet-ds", operation: "byOwnField:driverId" } },
        trips: { target: "test.Trip", cardinality: "one-to-many", resolution: { dataSourceId: "fleet-ds", operation: "byForeignKey:vehicleId" } }
      },
      "x-computed": { label: { dependsOn: ["name"], binding: "label" } },
      "x-policy": { objectPolicy: "vehicle.read" }
    },
    {
      label: async (ctx) => {
        headlineCalls.push(ctx.objectId);
        // A record only the warranty system holds has no name.
        return String(await ctx.getProperty("name").catch(() => "(unnamed)")).toUpperCase();
      }
    }
  );
  await registry.registerMapping({ id: "map-Vehicle-warranty", typeName: "test.Vehicle", target: "property", targetName: "warranty", dataSourceId: "warranty-ds", operation: "get", resolutionMode: "live" });
  await register("test.Driver", { title: "Driver", properties: { id: { type: "string" }, name: { type: "string" } }, "x-policy": { objectPolicy: "public" } });
  await register(
    "test.Trip",
    {
      title: "Trip",
      properties: { id: { type: "string" }, vehicleId: { type: "string" }, route: { type: "string" } },
      "x-computed": { peek: { dependsOn: ["route"], binding: "peek" } },
      "x-policy": { objectPolicy: "public" }
    },
    {
      // A Trip's own computed property reads some other object — one that doesn't exist — and so fails with a
      // not-found of its own, which is not the Trip being a dangling reference.
      peek: async (ctx) => (ctx.objectId === "t-peek" ? (await runtimeRef.current!.getObject("test.Vehicle", "ghost", dispatcher)).objectId : "ok")
    }
  );
  await register("test.Ticket", { title: "Ticket", properties: { id: { type: "string" }, ownerId: { type: "string" }, title: { type: "string" } }, "x-policy": { objectPolicy: opts.ticketPolicy ?? "ticket.read" } });

  const engine = new AbacPolicyEngine();
  for (const [name, rule] of Object.entries(opts.rules ?? RULES)) engine.registerRule(name, rule);
  const fleet = new FleetAdapter();
  const runtime = new SemanticRuntime(registry, [fleet, new WarrantyAdapter()], engine);
  runtimeRef.current = runtime;
  return { runtime, registry, fleet, headlineCalls };
}

async function auditRows(registry: SemanticRegistry) {
  return (await registry.listAuditEvents({ limit: 1000 })).items;
}

/** What went wrong, for asserting on the class without letting a rejection through as a pass. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject");
}

type Obj = { objectId: string; values: Record<string, unknown> };
const ids = (objs: unknown) => (objs as Obj[]).map((o) => o.objectId).sort();

describe("A missing object is not found (ADR-0048)", () => {
  describe("getObject", () => {
    it("raises ObjectNotFoundError — a NotFoundError naming the Type and id, and nothing else", async () => {
      const { runtime } = await setup();
      const err = await failure(runtime.getObject("test.Vehicle", "nope", dispatcher));

      expect(err).toBeInstanceOf(ObjectNotFoundError);
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.name).toBe("ObjectNotFoundError");
      expect(err.message).toBe("Not found: test.Vehicle/nope");
      expect((err as ObjectNotFoundError).typeName).toBe("test.Vehicle");
      expect((err as ObjectNotFoundError).objectId).toBe("nope");
      expect(Object.keys(err).sort()).toEqual(["name", "objectId", "typeName"]);
    });

    it("still returns an object that exists", async () => {
      const { runtime } = await setup();
      const v1 = await runtime.getObject("test.Vehicle", "v1", dispatcher);
      expect(v1.values).toMatchObject({ id: "v1", name: "Van 1", label: "VAN 1" });
    });

    it("an object that only an override source holds is not missing", async () => {
      const { runtime } = await setup();
      const held = await runtime.getObject("test.Vehicle", "v-ovr", dispatcher);
      expect(held.values.warranty).toBe("active");
    });

    it("an unknown Type is still a NotFoundError, and not an ObjectNotFoundError", async () => {
      const { runtime } = await setup();
      const err = await failure(runtime.getObject("test.Nope", "x", dispatcher));
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err).not.toBeInstanceOf(ObjectNotFoundError);
    });

    it("never finalizes a missing object: no computed property runs", async () => {
      const { runtime, headlineCalls } = await setup();
      await failure(runtime.getObject("test.Vehicle", "nope", dispatcher));
      expect(headlineCalls).toEqual([]);
    });

    it("query is unchanged: a filter that matches nothing is an empty page, not an error", async () => {
      const { runtime } = await setup();
      const result = await runtime.query({ type: "test.Vehicle", filter: { property: "name", operator: "eq", value: "no such van" } }, dispatcher);
      expect(result.items).toEqual([]);
    });
  });

  describe("a relationship and its provenance", () => {
    it("getRelationship of a missing source is ObjectNotFoundError", async () => {
      const { runtime } = await setup();
      const err = await failure(runtime.getRelationship("test.Vehicle", "nope", "trips", dispatcher));
      expect(err).toBeInstanceOf(ObjectNotFoundError);
      expect((err as ObjectNotFoundError).objectId).toBe("nope");
    });

    it("getProvenance of a missing object is ObjectNotFoundError; of an existing one, its provenance", async () => {
      const { runtime } = await setup();
      expect(await failure(runtime.getProvenance("test.Vehicle", "nope", "name", dispatcher))).toBeInstanceOf(ObjectNotFoundError);
      expect((await runtime.getProvenance("test.Vehicle", "v1", "name", dispatcher)).map((p) => p.propertyPath)).toEqual(["name"]);
    });

    it("a one-to-one reference to a record nothing holds is left out, not returned hollow", async () => {
      const { runtime } = await setup();
      expect(ids(await runtime.getRelationship("test.Vehicle", "v1", "driver", dispatcher))).toEqual(["d1"]);
      expect(await runtime.getRelationship("test.Vehicle", "v2", "driver", dispatcher)).toEqual([]);
    });

    it("a dangling reference among many is left out, and the rest are returned", async () => {
      const { runtime, fleet } = await setup();
      fleet.staleTripRefs = ["t-gone"];
      const trips = await runtime.getRelationship("test.Vehicle", "v1", "trips", dispatcher);
      expect(ids(trips)).toEqual(["t1", "t2"]);
      for (const trip of trips) expect(Object.keys(trip.values).length).toBeGreaterThan(0);
    });

    it("an include leaves out a dangling reference too, and the query still succeeds", async () => {
      const { runtime, fleet } = await setup();
      fleet.staleTripRefs = ["t-gone"];
      const { items } = await runtime.query(
        { type: "test.Vehicle", filter: { property: "id", operator: "in", value: ["v1", "v2"] }, include: [{ relationship: "trips" }, { relationship: "driver" }] },
        dispatcher
      );
      const byId = Object.fromEntries(items.map((i) => [i.objectId, i.values]));
      expect(ids(byId.v1!.trips)).toEqual(["t1", "t2"]);
      expect(ids(byId.v1!.driver)).toEqual(["d1"]);
      expect(byId.v2!.driver).toEqual([]);
    });

    it("an error reading a related object for any other reason still propagates", async () => {
      const { runtime, fleet } = await setup();
      fleet.staleTripRefs = ["t-boom"];
      await expect(runtime.getRelationship("test.Vehicle", "v1", "trips", dispatcher)).rejects.toThrow("the fleet database is on fire");
    });

    it("only the failure for that reference is swallowed: another object's not-found, raised while reading it, propagates", async () => {
      const { runtime } = await setup();
      // t-peek exists; its computed property reads Vehicle/ghost, which doesn't.
      const err = await failure(runtime.getRelationship("test.Vehicle", "v3", "trips", dispatcher));
      expect(err).toBeInstanceOf(ObjectNotFoundError);
      expect((err as ObjectNotFoundError).objectId).toBe("ghost");
    });
  });

  describe("the decision comes first", () => {
    it("a caller the policy denies gets AuthorizationError for a missing id, not a not-found", async () => {
      const { runtime } = await setup();
      const err = await failure(runtime.getObject("test.Vehicle", "nope", outsider));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(err).not.toBeInstanceOf(NotFoundError);
    });

    it("the same holds for a missing source in getRelationship and getProvenance", async () => {
      const { runtime } = await setup();
      expect(await failure(runtime.getRelationship("test.Vehicle", "nope", "trips", outsider))).toBeInstanceOf(AuthorizationError);
      expect(await failure(runtime.getProvenance("test.Vehicle", "nope", "name", outsider))).toBeInstanceOf(AuthorizationError);
    });

    it("a not-found read is audited as the decision it was: one allow, no deny", async () => {
      const { runtime, registry } = await setup();
      await failure(runtime.getObject("test.Vehicle", "nope", dispatcher));
      const rows = (await auditRows(registry)).filter((e) => e.resource.objectId === "nope");
      expect(rows.map((e) => [e.decision, e.operation])).toEqual([["allow", "getObject"]]);
    });
  });

  describe("attack: probing ids to learn what exists", () => {
    it("under a row-level rule, a missing id and a forbidden one are the same refusal", async () => {
      const { runtime } = await setup();
      const forbidden = await failure(runtime.getObject("test.Ticket", "k2", alice));
      const missing = await failure(runtime.getObject("test.Ticket", "k-nope", alice));

      expect(forbidden).toBeInstanceOf(AuthorizationError);
      expect(missing).toBeInstanceOf(AuthorizationError);
      expect(missing.name).toBe(forbidden.name);
      expect(missing.message.replace("k-nope", "ID")).toBe(forbidden.message.replace("k2", "ID"));
      expect((await runtime.getObject("test.Ticket", "k1", alice)).values.title).toBe("T-ALPHA");
    });

    it("under a role rule, an outsider gets one answer for every id, existing or not", async () => {
      const { runtime } = await setup();
      const existing = await failure(runtime.getObject("test.Vehicle", "v1", outsider));
      const missing = await failure(runtime.getObject("test.Vehicle", "nope", outsider));
      expect(existing).toBeInstanceOf(AuthorizationError);
      expect(missing.name).toBe(existing.name);
      expect(missing.message.replace("nope", "ID")).toBe(existing.message.replace("v1", "ID"));
    });

    it("a caller with no attributes cannot tell a Ticket from a missing one by any read path", async () => {
      const { runtime } = await setup();
      const mallory: Identity = { subjectId: "mallory", roles: ["staff"], attributes: {} };
      for (const id of ["k1", "k2", "k-nope"]) {
        expect(await failure(runtime.getObject("test.Ticket", id, mallory))).toBeInstanceOf(AuthorizationError);
        expect(await failure(runtime.getProvenance("test.Ticket", id, "title", mallory))).toBeInstanceOf(AuthorizationError);
      }
    });

    it("no stored value reaches the not-found error or the refusals", async () => {
      const { runtime } = await setup();
      const errors = [
        await failure(runtime.getObject("test.Ticket", "k2", alice)),
        await failure(runtime.getObject("test.Ticket", "k-nope", alice)),
        await failure(runtime.getObject("test.Vehicle", "nope", dispatcher))
      ];
      for (const err of errors) {
        const seen = [err.name, err.message, JSON.stringify(err)].join(" ");
        for (const secret of TICKET_SECRETS) expect(seen).not.toContain(secret);
      }
    });

    it("documented residual: a rule that admits an empty record lets a denied caller tell missing from denied", async () => {
      const { runtime } = await setup({ ticketPolicy: "ticket.deny-bob" });
      const bobbed: Identity = { subjectId: "anyone", roles: [], attributes: {} };
      // The rule allows every Ticket except bob's — and so allows an object with no attributes.
      expect(await failure(runtime.getObject("test.Ticket", "k-nope", bobbed))).toBeInstanceOf(ObjectNotFoundError);
      expect(await failure(runtime.getObject("test.Ticket", "k2", bobbed))).toBeInstanceOf(AuthorizationError);
    });
  });
});
