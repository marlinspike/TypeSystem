import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime, type SemanticRuntimeOptions } from "../src/runtime/runtime.js";
import { HIGH_ASSURANCE_V1 } from "../src/runtime/security-profile.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { AbacPolicyEngine, allOf, allowAllRule, anyOf, requireAttributeMatch, requireRole, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import type { Adapter, AdapterQueryResult, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter } from "../src/model/query.js";
import type { Identity, PolicyEngine, PolicyRequest } from "../src/model/policy.js";

/**
 * ADR-0043: a rule branch that fails to evaluate is a fault, recorded on the
 * decision and in the audit row whatever the decision is — so an `anyOf`
 * alternative that throws can't hide behind a later one that allows.
 */
const SECRET_IN_ERROR = "owner carol has SSN 123-45-6789";
const throwing: PolicyRule = () => {
  throw new Error(SECRET_IN_ERROR);
};
const throwsOnBob: PolicyRule = (r) => {
  if (r.resource.attributes?.ownerId === "bob") throw new Error(SECRET_IN_ERROR);
  return { allow: false, reason: "not special" };
};
const staff: Identity = { subjectId: "alice", roles: ["staff"], attributes: { userId: "alice" } };
const request = (subject: Identity = staff): PolicyRequest => ({ subject, action: "read", policyName: "p", resource: { typeName: "T", objectId: "o", attributes: {} } });

describe("policy faults (ADR-0043)", () => {
  describe("the combinators", () => {
    it("an anyOf alternative that throws is a fault even when a later one allows", async () => {
      expect(await anyOf(throwing, requireRole("staff"))(request())).toEqual({ allow: true, faults: ["anyOf alternative 1 failed to evaluate"] });
      const denied = await anyOf(requireRole("auditor"), throwing)(request());
      expect(denied).toMatchObject({ allow: false, faults: ["anyOf alternative 2 failed to evaluate"] });
    });

    it("faults compose through nesting: an allOf passes on its children's, and an anyOf the allowing branch's", async () => {
      expect(await allOf(requireRole("staff"), anyOf(throwing, allowAllRule))(request())).toEqual({ allow: true, faults: ["anyOf alternative 1 failed to evaluate"] });
      expect(await anyOf(anyOf(throwing, allowAllRule), throwing)(request())).toEqual({ allow: true, faults: ["anyOf alternative 1 failed to evaluate"] });
      // A branch that denied with a fault, then one that allows: the fault survives the allow.
      expect(await anyOf(anyOf(throwing, requireRole("auditor")), allowAllRule)(request())).toEqual({ allow: true, faults: ["anyOf alternative 1 failed to evaluate"] });
      // An allOf that throws denies its conjunction — and is itself a failed alternative of the anyOf around it.
      expect(await anyOf(allOf(throwing), requireRole("staff"))(request())).toEqual({ allow: true, faults: ["anyOf alternative 1 failed to evaluate"] });
    });

    it("an alternative after the one that allows never runs, so it reports nothing", async () => {
      expect(await anyOf(requireRole("staff"), throwing)(request())).toEqual({ allow: true });
    });

    it("never carries the error's message", async () => {
      const decision = await anyOf(throwing, requireRole("auditor"))(request());
      expect(JSON.stringify(decision)).not.toContain("123-45-6789");
    });
  });

  describe("in the runtime", () => {
    const DATA: Record<string, Record<string, unknown>> = { c1: { id: "c1", ownerId: "alice" }, c2: { id: "c2", ownerId: "bob" } };
    class Store implements Adapter {
      readonly dataSourceId = "ds";
      async resolveProperties(_t: string, id: string): Promise<ResolvedProperties> {
        return { values: { ...(DATA[id] ?? {}) }, provenance: [] };
      }
      async queryByType(_t: string, filter?: QueryFilter): Promise<AdapterQueryResult> {
        return { items: Object.entries(DATA).filter(([, v]) => matchesFilter(v, filter)).map(([objectId, v]) => ({ objectId, values: { ...v }, provenance: [] })) };
      }
      async resolveRelationship() {
        return [];
      }
      async executeAction() {
        return {};
      }
    }
    async function setup(engine: PolicyEngine, options: SemanticRuntimeOptions = {}) {
      const registry = new SemanticRegistry(new InMemoryRegistryStore());
      await registry.registerType(
        { $id: "https://typesys.dev/types/test/Case/1.0.0", type: "object", title: "Case", properties: { id: { type: "string" }, ownerId: { type: "string" } }, "x-policy": { objectPolicy: "case.read" } },
        { name: "test.Case", version: "1.0.0" }
      );
      await registry.registerMapping({ id: "m", typeName: "test.Case", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
      return { runtime: new SemanticRuntime(registry, [new Store()], engine, options), registry };
    }
    const abac = (rule: PolicyRule) => {
      const engine = new AbacPolicyEngine();
      engine.registerRule("case.read", rule);
      return engine;
    };
    const rows = async (registry: SemanticRegistry) => (await registry.listAuditEvents({ limit: 100 })).items.filter((e) => e.resource.objectId);

    it("attack: an allow reached around a broken branch is audited with the fault — per object, in a query too", async () => {
      const { runtime, registry } = await setup(abac(anyOf(throwsOnBob, requireAttributeMatch("ownerId", "userId"), requireRole("staff"))));
      expect((await runtime.query({ type: "test.Case" }, staff)).items.map((i) => i.objectId).sort()).toEqual(["c1", "c2"]);
      const byObject = new Map((await rows(registry)).map((e) => [e.resource.objectId, e]));
      expect(byObject.get("c2")).toMatchObject({ decision: "allow", details: { faults: ["anyOf alternative 1 failed to evaluate"] } });
      expect(byObject.get("c1")?.details).toBeUndefined();
      expect(JSON.stringify(await registry.listAuditEvents({ limit: 100 }))).not.toContain("123-45-6789");
    });

    it("a top-level rule that throws is a denied fault", async () => {
      const { runtime, registry } = await setup(abac(throwing));
      await expect(runtime.getObject("test.Case", "c1", staff)).rejects.toThrow();
      expect((await rows(registry))[0]).toMatchObject({ decision: "deny", details: { faults: ["policy case.read failed to evaluate"] } });
    });

    it("attack: whatever faults an engine answers are bounded — strings only, at most 16, at most 200 characters", async () => {
      const noisy: PolicyEngine = { evaluate: async () => ({ allow: true, faults: [7, { x: 1 }, "x".repeat(10_000), ...Array.from({ length: 40 }, (_, i) => `f${i}`)] as never }) };
      const { runtime, registry } = await setup(noisy);
      await runtime.getObject("test.Case", "c1", staff);
      const faults = (await rows(registry))[0]?.details?.faults as string[];
      expect(faults).toHaveLength(16);
      expect(faults.every((f) => typeof f === "string" && f.length <= 200)).toBe(true);
      expect(faults[0]).toBe("x".repeat(200));
      const odd: PolicyEngine = { evaluate: async () => ({ allow: true, faults: "not a list" as never }) };
      const oddWorld = await setup(odd);
      await oddWorld.runtime.getObject("test.Case", "c1", staff);
      expect((await rows(oddWorld.registry))[0]?.details).toBeUndefined();
    });

    describe("under HIGH_ASSURANCE_V1, engine fault text collapses to fixed codes (ADR-0047)", () => {
      const HA = { securityProfile: HIGH_ASSURANCE_V1 };
      const answered = [
        "anyOf alternative 2 failed to evaluate", // the combinators' own form: kept
        "record c1 belongs to carol, SSN 123-45-6789", // a custom engine's free text
        "Cedar policy forbid-high-level errored", // Cedar's form names a policy id: collapsed too, the id stays in onError
        "anyOf alternative 2 failed to evaluate: carol", // forged to look like the fixed form
        "anyOf alternative 12345 failed to evaluate"
      ];
      const faultsOf = async (engine: PolicyEngine, options: SemanticRuntimeOptions) => {
        const { runtime, registry } = await setup(engine, options);
        await runtime.getObject("test.Case", "c1", staff).catch(() => undefined);
        return (await rows(registry))[0]?.details?.faults;
      };

      it("attack: a custom engine's free text — even forged to look like the fixed form — is recorded as external-policy-fault", async () => {
        for (const allow of [true, false]) {
          const engine: PolicyEngine = { evaluate: async () => ({ allow, reason: "r", faults: answered }), plan: async () => ({ kind: "always" }) };
          expect(await faultsOf(engine, HA)).toEqual([
            "anyOf alternative 2 failed to evaluate",
            "external-policy-fault",
            "external-policy-fault",
            "external-policy-fault",
            "external-policy-fault"
          ]);
          // Outside the profile, ADR-0043's bounded text is unchanged.
          expect(await faultsOf(engine, {})).toEqual(answered);
        }
      });

      it("the combinators' faults and the runtime's own are kept", async () => {
        expect(await faultsOf(abac(anyOf(throwsOnBob, throwing, requireRole("staff"))), HA)).toEqual(["anyOf alternative 2 failed to evaluate"]);
        expect(await faultsOf(abac(throwing), HA)).toEqual(["policy case.read failed to evaluate"]);
      });
    });
  });
});
