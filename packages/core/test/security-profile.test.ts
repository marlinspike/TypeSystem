import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime, type SemanticRuntimeOptions } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { computeAggregations } from "../src/runtime/query-ops.js";
import { InMemoryCache } from "../src/runtime/cache.js";
import { DEMO_LINEAR_CLASSIFICATION, linearClassification, securityLabels } from "../src/runtime/classification.js";
import { HIGH_ASSURANCE_V1, SecurityProfileError } from "../src/runtime/security-profile.js";
import { AbacPolicyEngine, allOf, anyOf, requireAttributeMatch, requireRole, type PlannableRule, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import { predicatePlan } from "../src/policy/authorization-plan.js";
import { AuthorizationError, AuthorizationPlanError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, ResolvedProperties } from "../src/runtime/adapter.js";
import type { AggregateResult, QueryFilter, SemanticAggregateQuery } from "../src/model/query.js";
import type { Identity, PolicyEngine, PolicyRequest } from "../src/model/policy.js";

/**
 * ADR-0046: `HIGH_ASSURANCE_V1` is a versioned set of guarantees the runtime
 * checks at construction, supplying the settings they fix and refusing
 * weaker ones — and admitting aggregation only through structurally derived
 * plans, since an aggregate has no per-object check after it.
 */
const DATA: Record<string, Record<string, unknown>> = { c1: { id: "c1", ownerId: "alice" }, c2: { id: "c2", ownerId: "bob" }, c3: { id: "c3", ownerId: "alice" } };
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
  async aggregate(query: SemanticAggregateQuery): Promise<AggregateResult> {
    return computeAggregations(Object.values(DATA).filter((v) => matchesFilter(v, query.filter)), query);
  }
  async executeAction() {
    return {};
  }
}
const owner = requireAttributeMatch("ownerId", "userId");
/** Decides like `owner`, but its plan is hand-written: correct here, and not structural. */
const handPlanned: PlannableRule = Object.assign((r: PolicyRequest) => owner(r), {
  plan: (r: PolicyRequest) => predicatePlan({ attribute: "ownerId", eq: r.subject.attributes.userId as string })
});

async function world(options: SemanticRuntimeOptions & { rule?: PolicyRule; engine?: PolicyEngine; adapters?: Adapter[] } = {}) {
  const { rule, engine, adapters, ...runtimeOptions } = options;
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registry.registerType(
    { $id: "https://typesys.dev/types/test/Case/1.0.0", type: "object", title: "Case", properties: { id: { type: "string" }, ownerId: { type: "string" } }, "x-policy": { objectPolicy: "case.read" } },
    { name: "test.Case", version: "1.0.0" }
  );
  await registry.registerMapping({ id: "m", typeName: "test.Case", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  const abac = new AbacPolicyEngine();
  abac.registerRule("case.read", rule ?? owner);
  return { runtime: new SemanticRuntime(registry, adapters ?? [new Store()], engine ?? abac, runtimeOptions), registry };
}
const HA = { securityProfile: HIGH_ASSURANCE_V1 };
const alice: Identity = { subjectId: "alice", roles: ["staff"], attributes: { userId: "alice" } };
const count = { type: "test.Case", aggregations: [{ name: "n", op: "count" as const }] };
const violations = async (options: Parameters<typeof world>[0]) => {
  const err = await world(options).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(SecurityProfileError);
  return (err as SecurityProfileError).violations;
};

describe("HIGH_ASSURANCE_V1 (ADR-0046)", () => {
  it("is a frozen, versioned statement of guarantees", () => {
    expect(HIGH_ASSURANCE_V1.id).toBe("typesys:high-assurance:1");
    expect(HIGH_ASSURANCE_V1.guarantees).toHaveLength(6);
    expect(Object.isFrozen(HIGH_ASSURANCE_V1) && Object.isFrozen(HIGH_ASSURANCE_V1.guarantees)).toBe(true);
  });

  it("supplies what its guarantees fix: exact row security, and reports itself", async () => {
    const { runtime } = await world({ ...HA, rule: (r) => owner(r) }); // an opaque rule: never exact
    expect(runtime.securityProfile).toBe("typesys:high-assurance:1");
    await expect(runtime.query({ type: "test.Case" }, alice)).rejects.toBeInstanceOf(AuthorizationPlanError);
    expect((await (await world(HA)).runtime.explainQuery({ type: "test.Case" }, alice)).securityProfile).toBe("typesys:high-assurance:1");
  });

  describe("attack: a downgrade, a typo, or a malformed component stops the runtime from starting", () => {
    it("explicit weaker settings are refused — all of them, at once", async () => {
      expect(await violations({ ...HA, rowSecurity: "post-filter", telemetryIdentity: "clear" })).toEqual([
        'rowSecurity must be "require-exact", not "post-filter"',
        'telemetryIdentity must not be "clear"'
      ]);
    });

    it("an unknown option name — a likely typo that would otherwise be ignored — is refused", async () => {
      expect(await violations({ ...HA, rowSecurty: "require-exact" } as never)).toEqual(['unknown option "rowSecurty"']);
    });

    it("an unknown, future, or forged profile is refused", async () => {
      for (const securityProfile of [{ id: "typesys:high-assurance:2", guarantees: [] }, { id: "strict" }, null, "typesys:high-assurance:1"]) {
        await expect(world({ securityProfile: securityProfile as never })).rejects.toBeInstanceOf(SecurityProfileError);
      }
    });

    it("demonstration schemes are refused; a deployment's own scheme is not", async () => {
      expect(await violations({ ...HA, classification: DEMO_LINEAR_CLASSIFICATION })).toEqual(['the classification scheme "demo-linear" is a demonstration']);
      expect(await violations({ ...HA, classification: securityLabels({ levels: ["LOW", "HIGH"], homeCountry: "USA" }) })).toEqual(['the classification scheme "security-labels" is a demonstration']);
      await expect(world({ ...HA, classification: linearClassification(["PUBLIC", "RESTRICTED"], "acme") })).resolves.toBeDefined();
    });

    it("local or unknown key management is refused, managed is accepted", async () => {
      const reporting = (keyManagement: string): Adapter => Object.assign(new Store(), { keyManagement }) as unknown as Adapter;
      expect(await violations({ ...HA, adapters: [reporting("local")] })).toEqual(['adapter "ds" reports "local" key management; keys must be managed']);
      expect(await violations({ ...HA, adapters: [reporting("unknown")] })).toHaveLength(1);
      expect(await violations({ ...HA, cache: Object.assign(new InMemoryCache(), { keyManagement: "local" as const }) })).toEqual(['the cache reports "local" key management; keys must be managed']);
      await expect(world({ ...HA, adapters: [reporting("managed")] })).resolves.toBeDefined();
    });

    it("a malformed scheme, engine, cache, or telemetry policy is refused", async () => {
      expect(await violations({ ...HA, classification: { name: "half" } as never })).toEqual(["the classification scheme is malformed"]);
      expect(await violations({ ...HA, engine: { evaluate: "yes" } as never })).toEqual(["the policy engine has no evaluate()"]);
      expect(await violations({ ...HA, engine: { evaluate: async () => ({ allow: false }), planAssurance: "structural" } as never })).toEqual(["the policy engine's planAssurance is not a function"]);
      expect(await violations({ ...HA, cache: { confidential: "yes" } as never })).toEqual(["the cache is malformed"]);
      expect(await violations({ ...HA, telemetryIdentity: { mode: "pseudonymous", key: new Uint8Array(8) } })).toEqual(["telemetryIdentity's pseudonym key must be at least 32 bytes"]);
      await expect(world({ ...HA, telemetryIdentity: { mode: "pseudonymous", key: new Uint8Array(32) } })).resolves.toBeDefined();
    });
  });

  describe("aggregation needs a structurally derived plan — reads don't", () => {
    it("the ABAC combinators say which plans are structural", () => {
      const engine = new AbacPolicyEngine();
      const rules: Record<string, PolicyRule> = {
        leaf: owner,
        nested: anyOf(requireRole("auditor"), allOf(requireRole("staff"), owner)),
        opaqueChild: anyOf(owner, (r) => owner(r)),
        handPlanned,
        overHandPlanned: anyOf(requireRole("auditor"), handPlanned)
      };
      for (const [name, rule] of Object.entries(rules)) engine.registerRule(name, rule);
      const assurance = (policyName: string) => engine.planAssurance({ subject: alice, action: "read", policyName, resource: { typeName: "T" } });
      expect(Object.keys(rules).map((n) => [n, assurance(n)])).toEqual([
        ["leaf", "structural"],
        ["nested", "structural"],
        ["opaqueChild", "structural"], // a plain function plans unknown, which trusts nothing
        ["handPlanned", "unverified"],
        ["overHandPlanned", "unverified"]
      ]);
      expect(assurance("unregistered")).toBe("structural");
    });

    it("attack: an exact but unverified plan can't admit an aggregate under the profile — though it still serves reads", async () => {
      const { runtime, registry } = await world({ ...HA, rule: handPlanned });
      expect((await runtime.query({ type: "test.Case" }, alice)).items.map((i) => i.objectId)).toEqual(["c1", "c3"]);
      await expect(runtime.aggregate(count, alice)).rejects.toThrow(/was not derived structurally, and an aggregate has no per-object check/);
      const [refusal] = (await registry.listAuditEvents({ limit: 20 })).items.filter((e) => e.details?.assurance === "unverified");
      expect(refusal).toMatchObject({ decision: "deny", details: { control: "row-plan", plan: "predicate", exact: true } });
      // Without the profile, the same plan admits it (ADR-0038).
      expect((await (await world({ rule: handPlanned })).runtime.aggregate(count, alice)).groups[0]!.values.n).toBe(2);
    });

    it("a structural plan admits it; an engine that can't vouch, or whose vouching fails, can't", async () => {
      expect((await (await world(HA)).runtime.aggregate(count, alice)).groups[0]!.values.n).toBe(2);
      const abac = new AbacPolicyEngine();
      abac.registerRule("case.read", owner);
      const silent: PolicyEngine = { evaluate: (r) => abac.evaluate(r), plan: (r) => abac.plan(r) };
      const failing: PolicyEngine = { ...silent, planAssurance: () => Promise.reject(new Error("down")) };
      const claimsOther: PolicyEngine = { ...silent, planAssurance: () => "verified" as never };
      for (const engine of [silent, failing, claimsOther]) {
        await expect((await world({ ...HA, engine })).runtime.aggregate(count, alice)).rejects.toBeInstanceOf(AuthorizationError);
      }
    });
  });
});
