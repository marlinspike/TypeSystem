import { describe, it, expect } from "vitest";
import {
  AbacPolicyEngine,
  SemanticRegistry,
  SemanticRuntime,
  InMemoryRegistryStore,
  allowAllRule,
  buildRuntime,
  coreManifest,
  type ActionContext,
  type ActionDefinition,
  type Adapter,
  type Identity,
  type QueryFilter,
  type SemanticTypeSchema
} from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { buildHospitalTestbed, hospitalDemoIdentities, hospitalManifest, hospitalPolicyRules, HOSPITAL_DATA_SOURCE_ID } from "@typesys/domain-hospital";
import { BLIND_INDEX_PREFIX, DecryptionError, EncryptedFieldError, EncryptingAdapter, EncryptionConfigError, LocalKeyProvider, type EncryptionConfig } from "../src/index.js";

/**
 * `EncryptingAdapter` (ADR-0033), through the real `node:crypto` primitives
 * and the real in-memory and mock-REST adapters — no mocked cryptography.
 * Keys are fixed bytes, so every run is deterministic where it should be.
 */
const KEY_BYTES: Record<string, string> = {
  k1: Buffer.alloc(32, 0x11).toString("base64"),
  k2: Buffer.alloc(32, 0x22).toString("base64"),
  impostor: Buffer.alloc(32, 0x99).toString("base64")
};
const keyring = (active: string, ...retired: string[]) =>
  new LocalKeyProvider({ keys: Object.fromEntries([active, ...retired].map((id) => [id, KEY_BYTES[id]!])), active });

// ---------------------------------------------------------------------------
// A small synthetic model for the mechanism
// ---------------------------------------------------------------------------

const MEMBER_CONFIG: EncryptionConfig = {
  fields: {
    "test.Member": { ssn: { mode: "deterministic" }, email: { mode: "deterministic" }, teamId: { mode: "deterministic" }, dob: {}, profile: {} }
  },
  actions: { EnrollMember: { type: "test.Member", idField: "id" }, Ping: null }
};

const MEMBERS: Record<string, Record<string, unknown>> = {
  m1: { id: "m1", name: "Ada", ssn: "123-45-6789", email: "ada@example.test", teamId: "t1", dob: "1990-01-01", profile: { score: 7, tags: ["ops", "✓"], active: true, note: null } },
  m2: { id: "m2", name: "Bo", ssn: "987-65-4321", email: "bo@example.test", teamId: "t1", dob: "1990-01-01", profile: 42 },
  m3: { id: "m3", name: "Cy", ssn: "123-45-6789", email: "cy@example.test", teamId: "t2", dob: null }
};

async function memberWorld(keys = keyring("k1")) {
  const inner = new InMemoryRepositoryAdapter("members-ds");
  const adapter = new EncryptingAdapter(inner, keys, MEMBER_CONFIG);
  inner.seed("test.Member", await Promise.all(Object.entries(MEMBERS).map(async ([objectId, values]) => ({ objectId, values: await adapter.seal("test.Member", objectId, values) }))));
  inner.seed("test.Badge", [{ objectId: "b1", values: { id: "b1", memberId: "m1" } }]);
  return { inner, adapter };
}

async function memberRuntime(adapter: Adapter) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const strings = (names: string[]) => Object.fromEntries(names.map((n) => [n, { type: "string" }]));
  const register = async (name: string, schema: Omit<SemanticTypeSchema, "$id" | "type" | "title">) => {
    const short = name.split(".")[1]!;
    await registry.registerType({ $id: `https://typesys.dev/types/test/${short}/1.0.0`, type: "object", title: short, ...schema }, { name, version: "1.0.0" });
    await registry.registerMapping({ id: `map-${short}`, typeName: name, target: "property", targetName: "*", dataSourceId: "members-ds", operation: "get", resolutionMode: "live" });
  };
  await register("test.Badge", { properties: strings(["id", "memberId"]), "x-policy": { objectPolicy: "public" } });
  await register("test.Member", {
    properties: strings(["id", "name", "ssn", "email", "teamId", "dob"]),
    "x-relationships": {
      badges: { target: "test.Badge", cardinality: "one-to-many", resolution: { dataSourceId: "members-ds", operation: "byForeignKey:memberId" } }
    },
    "x-policy": { objectPolicy: "public" }
  });
  await register("test.Team", {
    properties: strings(["id"]),
    "x-relationships": {
      members: { target: "test.Member", cardinality: "one-to-many", resolution: { dataSourceId: "members-ds", operation: "byForeignKey:teamId" } }
    },
    "x-policy": { objectPolicy: "public" }
  });
  await registry.registerAction({
    id: "action-enroll-member",
    name: "EnrollMember",
    description: "Creates or replaces a Member under the id its input names.",
    applicableTypes: ["test.Member"],
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    outputSchema: { type: "object" },
    authorizationPolicy: "public",
    implementation: { dataSourceId: "members-ds", operation: "enroll" },
    sideEffects: "creates",
    idempotency: "none",
    auditRequired: false,
    version: "1.0.0"
  });
  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  return new SemanticRuntime(registry, [adapter], policyEngine);
}

const anyone: Identity = { subjectId: "u", roles: [], attributes: {} };
const ids = (items: { objectId: string }[]) => items.map((i) => i.objectId).sort();
const query = (adapter: Adapter, filter: QueryFilter) => adapter.queryByType("test.Member", filter).then((r) => ids(r.items));
const stored = async (inner: InMemoryRepositoryAdapter, type: string, id: string) => (await inner.resolveProperties(type, id, [])).values;

// ---------------------------------------------------------------------------

describe("EncryptingAdapter (ADR-0033)", () => {
  describe("round trip", () => {
    it("reads back exactly what was sealed — every JSON type — with unencrypted fields untouched and no index in sight", async () => {
      const { adapter } = await memberWorld();
      for (const [id, values] of Object.entries(MEMBERS)) {
        const read = await adapter.resolveProperties("test.Member", id, []);
        expect(read.values).toEqual(values);
        expect(read.provenance.map((p) => p.propertyPath).some((p) => p.startsWith(BLIND_INDEX_PREFIX))).toBe(false);
      }
    });

    it("a randomized field never repeats a ciphertext; a deterministic one repeats only its index", async () => {
      const { adapter } = await memberWorld();
      const [a, b] = [await adapter.seal("test.Member", "m9", { dob: "1990-01-01", ssn: "123-45-6789" }), await adapter.seal("test.Member", "m9", { dob: "1990-01-01", ssn: "123-45-6789" })];
      expect(a.dob).not.toBe(b.dob);
      expect(a.ssn).not.toBe(b.ssn);
      expect(a[`${BLIND_INDEX_PREFIX}ssn`]).toBe(b[`${BLIND_INDEX_PREFIX}ssn`]);
    });

    it("the same value has unrelated indexes in different fields, and under different keys", async () => {
      const { adapter } = await memberWorld();
      const sealed = await adapter.seal("test.Member", "m9", { ssn: "same", email: "same" });
      expect(sealed[`${BLIND_INDEX_PREFIX}ssn`]).not.toBe(sealed[`${BLIND_INDEX_PREFIX}email`]);
      const other = await new EncryptingAdapter(new InMemoryRepositoryAdapter("x"), keyring("k2"), MEMBER_CONFIG).seal("test.Member", "m9", { ssn: "same" });
      expect(other[`${BLIND_INDEX_PREFIX}ssn`]).not.toBe(sealed[`${BLIND_INDEX_PREFIX}ssn`]);
    });
  });

  describe("equality survives on a deterministic field", () => {
    it("eq, in, and ne — alone and inside and/or with ordinary conditions", async () => {
      const { adapter } = await memberWorld();
      expect(await query(adapter, { property: "ssn", operator: "eq", value: "123-45-6789" })).toEqual(["m1", "m3"]);
      expect(await query(adapter, { property: "ssn", operator: "in", value: ["987-65-4321", "000-00-0000"] })).toEqual(["m2"]);
      expect(await query(adapter, { property: "ssn", operator: "ne", value: "123-45-6789" })).toEqual(["m2"]);
      expect(await query(adapter, { and: [{ property: "ssn", operator: "eq", value: "123-45-6789" }, { property: "name", operator: "eq", value: "Cy" }] })).toEqual(["m3"]);
      expect(await query(adapter, { or: [{ property: "email", operator: "eq", value: "bo@example.test" }, { property: "teamId", operator: "eq", value: "t2" }] })).toEqual(["m2", "m3"]);
      expect(await query(adapter, { property: "ssn", operator: "in", value: "not-an-array" })).toEqual([]);
    });

    it("through the runtime, and in a count", async () => {
      const { adapter } = await memberWorld();
      const runtime = await memberRuntime(adapter);
      expect(ids((await runtime.query({ type: "test.Member", filter: { property: "email", operator: "eq", value: "ada@example.test" } }, anyone)).items)).toEqual(["m1"]);
      await expect(runtime.aggregate({ type: "test.Member", filter: { property: "teamId", operator: "eq", value: "t1" }, aggregations: [{ name: "n", op: "count" }] }, anyone)).resolves.toEqual({
        groups: [{ key: {}, values: { n: 2 } }]
      });
    });
  });

  describe("what breaks is refused with a clear error, never answered wrongly", () => {
    it("range, substring, and array filters on a deterministic field; any filter on a randomized one", async () => {
      const { adapter } = await memberWorld();
      for (const operator of ["gt", "gte", "lt", "lte", "contains"] as const) {
        await expect(query(adapter, { property: "ssn", operator, value: "1" })).rejects.toThrow(/supports eq, ne, and in/);
      }
      await expect(query(adapter, { property: "ssn", operator: "icontains", value: "1" })).rejects.toThrow(/Cannot search encrypted field test.Member.ssn/);
      await expect(query(adapter, { property: "dob", operator: "eq", value: "1990-01-01" })).rejects.toThrow(/Make it deterministic/);
      await expect(query(adapter, { or: [{ property: "name", operator: "eq", value: "Ada" }, { property: "dob", operator: "gt", value: 1 }] })).rejects.toBeInstanceOf(EncryptedFieldError);
    });

    it("sort, aggregation over the field, and a relationship keyed on it", async () => {
      const { adapter } = await memberWorld();
      const runtime = await memberRuntime(adapter);
      await expect(runtime.query({ type: "test.Member", sort: [{ property: "ssn", direction: "asc" }] }, anyone)).rejects.toThrow(/Cannot sort on encrypted field test.Member.ssn/);
      await expect(runtime.aggregate({ type: "test.Member", groupBy: ["teamId"], aggregations: [{ name: "n", op: "count" }] }, anyone)).rejects.toBeInstanceOf(EncryptedFieldError);
      await expect(runtime.aggregate({ type: "test.Member", aggregations: [{ name: "n", op: "count", property: "dob" }] }, anyone)).rejects.toBeInstanceOf(EncryptedFieldError);
      await expect(runtime.getRelationship("test.Team", "t1", "members", anyone)).rejects.toThrow(/resolve relationship "members" through/);
      expect(ids(await runtime.getRelationship("test.Member", "m1", "badges", anyone))).toEqual(["b1"]); // keyed on a plain field: fine
    });

    it("a search over an encrypted field — including a default search — says to name search.properties", async () => {
      const { adapter } = await memberWorld();
      const runtime = await memberRuntime(adapter);
      await expect(runtime.query({ type: "test.Member", search: { text: "ada" } }, anyone)).rejects.toThrow(/Name search.properties without it/);
      expect(ids((await runtime.query({ type: "test.Member", search: { text: "ada", properties: ["name"] } }, anyone)).items)).toEqual(["m1"]);
    });

    it("the reserved index fields can't be named in a filter, a sort, an aggregation, or a write", async () => {
      const { adapter } = await memberWorld();
      const reserved = `${BLIND_INDEX_PREFIX}ssn`;
      await expect(query(adapter, { property: reserved, operator: "eq", value: "x" })).rejects.toThrow(/reserved/);
      await expect(adapter.queryByType("test.Member", undefined, 10, undefined, [{ property: reserved, direction: "asc" }])).rejects.toThrow(/reserved/);
      await expect(adapter.aggregate({ type: "test.Member", groupBy: [reserved], aggregations: [{ name: "n", op: "count" }] })).rejects.toThrow(/reserved/);
      await expect(adapter.seal("test.Member", "m9", { ssn: "1", [reserved]: "forged" })).rejects.toThrow(/reserved/);
    });

    it("an unusable configuration is refused up front", () => {
      const inner = new InMemoryRepositoryAdapter("x");
      expect(() => new EncryptingAdapter(inner, keyring("k1"), { fields: { "t.T": { [`${BLIND_INDEX_PREFIX}x`]: {} } } })).toThrow(EncryptionConfigError);
      expect(() => new EncryptingAdapter(inner, keyring("k1"), { fields: { "t.T": { x: { mode: "ecb" as never } } } })).toThrow(/unknown mode/);
    });
  });

  describe("writes through an Action", () => {
    /** An in-memory store whose one Action creates or replaces a Member under the id its input names. */
    class EnrollingAdapter extends InMemoryRepositoryAdapter {
      override async executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
        const values = input as Record<string, unknown>;
        this.seed("test.Member", [{ objectId: String(values.id), values }]);
        return values;
      }
    }
    async function enrollingRuntime() {
      const inner = new EnrollingAdapter("members-ds");
      const adapter = new EncryptingAdapter(inner, keyring("k1"), MEMBER_CONFIG);
      return { inner, adapter, runtime: await memberRuntime(adapter) };
    }

    it("round-trips through the runtime's write path, bound to the record the input names, with only ciphertext stored", async () => {
      const { inner, runtime } = await enrollingRuntime();
      const created = (await runtime.invokeAction("EnrollMember", { id: "m7", name: "Dee", ssn: "555-00-1111", dob: "1988-08-08" }, anyone)) as Record<string, unknown>;
      expect(created).toEqual({ id: "m7", name: "Dee", ssn: "555-00-1111", dob: "1988-08-08" });
      expect((await runtime.getObject("test.Member", "m7", anyone)).values.dob).toBe("1988-08-08");

      const raw = await stored(inner, "test.Member", "m7");
      expect(raw.ssn).toMatch(/^tsenc2\.k1\./);
      expect(JSON.stringify(raw)).not.toMatch(/555-00-1111|1988-08-08/);
    });

    it("an Action that would write encrypted fields without the record's id is refused before the adapter runs", async () => {
      const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
      const encrypted = new EncryptingAdapter(tb.mockRestAdapter, keyring("k1"), {
        fields: { "airforce.WorkOrder": { assignedTo: {} } },
        actions: { CreateMaintenanceWorkOrder: { type: "airforce.WorkOrder", idField: "id" } }
      });
      const runtime = new SemanticRuntime(tb.registry, [tb.inMemoryAdapter, encrypted], tb.policyEngine);
      const before = (await tb.mockRestAdapter.queryByType("airforce.WorkOrder")).items.length;
      await expect(
        runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9001", assignedTo: "SSgt Rivera" }, demoIdentities.maintainer)
      ).rejects.toThrow(/carries no record id in "id"/);
      expect((await tb.mockRestAdapter.queryByType("airforce.WorkOrder")).items).toHaveLength(before);
    });

    it("an adapter that ignores the caller's id and assigns its own fails loudly on the result, never binding silently", async () => {
      const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
      const encrypted = new EncryptingAdapter(tb.mockRestAdapter, keyring("k1"), {
        fields: { "airforce.WorkOrder": { assignedTo: {} } },
        actions: { CreateMaintenanceWorkOrder: { type: "airforce.WorkOrder", idField: "id" } }
      });
      const runtime = new SemanticRuntime(tb.registry, [tb.inMemoryAdapter, encrypted], tb.policyEngine);
      // The mock REST system mints WO-0001 whatever id it is given: the ciphertext was bound to WO-CLIENT.
      await expect(
        runtime.invokeAction("CreateMaintenanceWorkOrder", { id: "WO-CLIENT", maintenanceEventId: "EVT-9001", assignedTo: "SSgt Rivera" }, demoIdentities.maintainer)
      ).rejects.toThrow(/WO-0001" failed authentication/);
      await expect(runtime.getObject("airforce.WorkOrder", "WO-0001", demoIdentities.maintainer)).rejects.toBeInstanceOf(DecryptionError);
    });

    it("an Action the config doesn't account for is refused before it runs; one mapped to null passes through", async () => {
      const { adapter } = await memberWorld();
      const ctx = {} as ActionContext;
      const action = (name: string) => ({ name }) as ActionDefinition;
      await expect(adapter.executeAction(action("DeleteEverything"), {}, ctx)).rejects.toThrow(/isn't in the encryption config's actions/);
      await expect(adapter.executeAction(action("Ping"), {}, ctx)).rejects.toThrow(/no implementation for action "Ping"/); // reached the inner adapter
    });

    it("existing plaintext in a newly encrypted field fails closed until it is re-written through seal", async () => {
      const { inner, adapter } = await memberWorld();
      inner.seed("test.Member", [{ objectId: "m8", values: { id: "m8", name: "Legacy", ssn: "000-11-2222" } }]);
      await expect(adapter.resolveProperties("test.Member", "m8", [])).rejects.toThrow(/is not an encrypted value/);
      await expect(adapter.queryByType("test.Member")).rejects.toBeInstanceOf(DecryptionError);
    });
  });

  describe("key rotation", () => {
    it("old values keep decrypting, new ones use the new key, and equality spans both — until the old key leaves the ring", async () => {
      const inner = new InMemoryRepositoryAdapter("members-ds");
      const before = new EncryptingAdapter(inner, keyring("k1"), MEMBER_CONFIG);
      inner.seed("test.Member", [{ objectId: "m1", values: await before.seal("test.Member", "m1", MEMBERS.m1!) }]);

      const rotated = new EncryptingAdapter(inner, keyring("k2", "k1"), MEMBER_CONFIG);
      inner.seed("test.Member", [{ objectId: "m3", values: await rotated.seal("test.Member", "m3", MEMBERS.m3!) }]);
      expect((await stored(inner, "test.Member", "m1")).ssn).toMatch(/^tsenc2\.k1\./);
      expect((await stored(inner, "test.Member", "m3")).ssn).toMatch(/^tsenc2\.k2\./);
      expect((await rotated.resolveProperties("test.Member", "m1", [])).values).toEqual(MEMBERS.m1);
      expect(await query(rotated, { property: "ssn", operator: "eq", value: "123-45-6789" })).toEqual(["m1", "m3"]); // one value, two keys' indexes

      const retired = new EncryptingAdapter(inner, keyring("k2"), MEMBER_CONFIG);
      await expect(retired.resolveProperties("test.Member", "m1", [])).rejects.toThrow(/key "k1", which the keyring doesn't hold/);
      expect((await retired.resolveProperties("test.Member", "m3", [])).values).toEqual(MEMBERS.m3);
    });
  });

  // -------------------------------------------------------------------------
  // The attack suite, on the hospital domain with its PHI encrypted
  // -------------------------------------------------------------------------

  const HOSPITAL_CONFIG: EncryptionConfig = {
    fields: {
      "hospital.Patient": { medicalRecordNumber: { mode: "deterministic" }, assignedClinicianId: { mode: "deterministic" }, dateOfBirth: {} }
    },
    actions: {}
  };
  /** The plaintext of every encrypted field — none may appear in the store, in any encoding. */
  const PHI = ["MRN-1001", "MRN-1002", "1985-03-14", "1993-11-02"];
  const encodings = (s: string) => [s, Buffer.from(s).toString("base64"), Buffer.from(s).toString("base64url"), Buffer.from(s).toString("hex"), JSON.stringify(s)];

  /** The hospital domain twice: once as shipped, once with its Patient PHI encrypted in the store. */
  async function hospitalWorlds(keys = keyring("k1")) {
    const plain = await buildHospitalTestbed();
    const inner = new InMemoryRepositoryAdapter(HOSPITAL_DATA_SOURCE_ID, "hospital-repo");
    const encrypted = new EncryptingAdapter(inner, keys, HOSPITAL_CONFIG);
    for (const type of ["hospital.Patient", "hospital.Provider", "hospital.Appointment"]) {
      const { items } = await plain.adapter.queryByType(type);
      inner.seed(type, await Promise.all(items.map(async (i) => ({ objectId: i.objectId, values: await encrypted.seal(type, i.objectId, i.values) }))));
    }
    const { runtime } = await buildRuntime({ manifests: [coreManifest, hospitalManifest], adapters: [encrypted], policyRules: hospitalPolicyRules });
    return { plain: plain.runtime, runtime, inner, encrypted, keys };
  }

  describe("attack: the store, a tamperer, and the wrong key", () => {
    it("reading the underlying store directly shows no plaintext, in any encoding", async () => {
      const { inner } = await hospitalWorlds();
      const dump = JSON.stringify((await inner.queryByType("hospital.Patient")).items);
      for (const value of PHI) for (const encoded of encodings(value)) expect(dump).not.toContain(encoded);
      // assignedClinicianId values appear elsewhere in the store as Provider ids, so check the Patient rows' field itself.
      for (const item of (await inner.queryByType("hospital.Patient")).items) expect(item.values.assignedClinicianId).toMatch(/^tsenc2\./);
    });

    it("a tampered ciphertext fails its tag — body, IV, key id, truncation — and the read fails, never returning plaintext", async () => {
      const { runtime, inner } = await hospitalWorlds();
      const original = await stored(inner, "hospital.Patient", "PT-1001");
      const envelope = original.medicalRecordNumber as string;
      const [prefix, keyId, iv, body] = envelope.split(".") as [string, string, string, string];
      const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
      const tampered = [
        `${prefix}.${keyId}.${iv}.${flip(body, 3)}`,
        `${prefix}.${keyId}.${iv}.${flip(body, body.length - 2)}`, // inside the tag
        `${prefix}.${keyId}.${flip(iv, 0)}.${body}`,
        `${prefix}.k2.${iv}.${body}`,
        `${prefix}.${keyId}.${iv}.${body.slice(0, 20)}`,
        `${prefix}.${keyId}.${iv}.`,
        "MRN-1001"
      ];
      for (const value of tampered) {
        inner.seed("hospital.Patient", [{ objectId: "PT-1001", values: { ...original, medicalRecordNumber: value } }]);
        const read = runtime.getObject("hospital.Patient", "PT-1001", hospitalDemoIdentities.clinician);
        await expect(read).rejects.toBeInstanceOf(DecryptionError);
        await expect(runtime.query({ type: "hospital.Patient" }, hospitalDemoIdentities.clinician)).rejects.toBeInstanceOf(DecryptionError);
      }
    });

    it("a ciphertext moved to another field or Type fails authentication", async () => {
      const { inner, encrypted } = await hospitalWorlds();
      const original = await stored(inner, "hospital.Patient", "PT-1001");
      inner.seed("hospital.Patient", [{ objectId: "PT-1001", values: { ...original, dateOfBirth: original.medicalRecordNumber } }]);
      await expect(encrypted.resolveProperties("hospital.Patient", "PT-1001", [])).rejects.toThrow(/hospital.Patient.dateOfBirth of "PT-1001" failed authentication/);

      const elsewhere = new EncryptingAdapter(inner, keyring("k1"), { fields: { "hospital.Provider": { specialty: {} } }, actions: {} });
      inner.seed("hospital.Provider", [{ objectId: "PR-2001", values: { id: "PR-2001", displayName: "Dr. Priya Nair", specialty: original.dateOfBirth } }]);
      await expect(elsewhere.resolveProperties("hospital.Provider", "PR-2001", [])).rejects.toBeInstanceOf(DecryptionError);
    });

    it("a ciphertext swapped between two records of the same Type and field is detected (the ADR-0033 residual, closed by ADR-0035)", async () => {
      const { inner, encrypted } = await hospitalWorlds();
      const [a, b] = [await stored(inner, "hospital.Patient", "PT-1001"), await stored(inner, "hospital.Patient", "PT-1002")];
      inner.seed("hospital.Patient", [{ objectId: "PT-1002", values: { ...b, dateOfBirth: a.dateOfBirth } }]);
      await expect(encrypted.resolveProperties("hospital.Patient", "PT-1002", [])).rejects.toThrow(/dateOfBirth of "PT-1002" failed authentication/);
    });

    it("an edited blind index can't redirect an equality lookup to the wrong record", async () => {
      const { runtime, inner } = await hospitalWorlds();
      const [a, b] = [await stored(inner, "hospital.Patient", "PT-1001"), await stored(inner, "hospital.Patient", "PT-1002")];
      const index = `${BLIND_INDEX_PREFIX}medicalRecordNumber`;
      inner.seed("hospital.Patient", [{ objectId: "PT-1002", values: { ...b, [index]: a[index] } }]);
      const lookup = runtime.query({ type: "hospital.Patient", filter: { property: "medicalRecordNumber", operator: "eq", value: "MRN-1001" } }, { subjectId: "adm", roles: ["admin"], attributes: {} });
      await expect(lookup).rejects.toThrow(/PT-1002" has a blind index that doesn't match its value/);
    });

    it("the wrong key — different material under the same id, or a missing id — fails closed and never yields plaintext", async () => {
      const { inner } = await hospitalWorlds();
      const impostor = new LocalKeyProvider({ keys: { k1: KEY_BYTES.impostor! }, active: "k1" });
      for (const keys of [impostor, keyring("k2")]) {
        const wrong = new EncryptingAdapter(inner, keys, HOSPITAL_CONFIG);
        const outcome = await wrong.resolveProperties("hospital.Patient", "PT-1001", []).then(
          (r) => r,
          (e: unknown) => e
        );
        expect(outcome).toBeInstanceOf(DecryptionError);
        for (const value of PHI) expect(String((outcome as Error).message)).not.toContain(value);
        await expect(wrong.queryByType("hospital.Patient", { property: "medicalRecordNumber", operator: "eq", value: "MRN-1001" })).resolves.toEqual({ items: [], nextCursor: undefined });
      }
    });

    it("no error ever carries a plaintext or a ciphertext", async () => {
      const { inner, encrypted } = await hospitalWorlds();
      const original = await stored(inner, "hospital.Patient", "PT-1001");
      inner.seed("hospital.Patient", [{ objectId: "PT-1001", values: { ...original, dateOfBirth: `${String(original.dateOfBirth).slice(0, -3)}AAA` } }]);
      const err = (await encrypted.resolveProperties("hospital.Patient", "PT-1001", []).catch((e: unknown) => e)) as Error;
      expect(err.message).not.toMatch(/tsenc\d\.[A-Za-z0-9_-]|1985|MRN/); // no envelope, no plaintext
      expect(err.message).toContain("hospital.Patient.dateOfBirth");
    });
  });

  describe("transparent to the runtime", () => {
    const identities: Identity[] = [...Object.values(hospitalDemoIdentities), { subjectId: "adm", roles: ["admin"], attributes: {} }];
    const stable = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === "retrievedAt" ? undefined : x))) as unknown;
    const settle = (p: Promise<unknown>) => p.then((ok) => ({ ok: stable(ok) }), (e: unknown) => ({ error: (e as Error).name, message: (e as Error).message }));

    it("every read path returns the same results with the PHI encrypted as without — row-level rules included", async () => {
      const { plain, runtime } = await hospitalWorlds();
      const reads: ((rt: SemanticRuntime, who: Identity) => Promise<unknown>)[] = [
        (rt, who) => rt.query({ type: "hospital.Patient", includeProvenance: true }, who),
        (rt, who) => rt.query({ type: "hospital.Patient", filter: { property: "medicalRecordNumber", operator: "eq", value: "MRN-1001" } }, who),
        (rt, who) => rt.query({ type: "hospital.Patient", filter: { property: "assignedClinicianId", operator: "in", value: ["PR-2002"] } }, who),
        (rt, who) => rt.query({ type: "hospital.Patient", filter: { property: "assignedClinicianId", operator: "ne", value: "PR-2002" } }, who),
        (rt, who) => rt.query({ type: "hospital.Provider", include: [{ relationship: "patients" }, { relationship: "appointments", include: [{ relationship: "patient" }] }] }, who),
        (rt, who) => rt.aggregate({ type: "hospital.Patient", filter: { property: "assignedClinicianId", operator: "eq", value: "PR-2001" }, aggregations: [{ name: "n", op: "count" }] }, who),
        ...["PT-1001", "PT-1002"].flatMap((id) => [
          (rt: SemanticRuntime, who: Identity) => rt.getObject("hospital.Patient", id, who, { includeProvenance: true }),
          (rt: SemanticRuntime, who: Identity) => rt.getRelationship("hospital.Patient", id, "appointments", who),
          ...["medicalRecordNumber", "dateOfBirth", "assignedClinicianId", "name"].map((p) => (rt: SemanticRuntime, who: Identity) => rt.getProvenance("hospital.Patient", id, p, who))
        ])
      ];
      let compared = 0;
      for (const who of identities) {
        for (const read of reads) {
          expect(await settle(read(runtime, who))).toEqual(await settle(read(plain, who)));
          compared++;
        }
      }
      expect(compared).toBe(identities.length * reads.length);
      // Not vacuous: the encrypted world did hand back real plaintext PHI to the one who may see it.
      expect((await runtime.getObject("hospital.Patient", "PT-1001", hospitalDemoIdentities.clinician)).values.medicalRecordNumber).toBe("MRN-1001");
    });
  });
});
