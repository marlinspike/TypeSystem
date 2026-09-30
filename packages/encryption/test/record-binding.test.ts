import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { ActionContext, ActionDefinition } from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { BLIND_INDEX_PREFIX, DecryptionError, EncryptedFieldError, EncryptingAdapter, EncryptionConfigError, LocalKeyProvider, type EncryptionConfig } from "../src/index.js";

/**
 * ADR-0035: `tsenc2` envelopes bind each ciphertext to its record, legacy
 * unbound `tsenc1` envelopes are refused outside a migration, and `reseal`
 * migrates them. Real `node:crypto` throughout; keys are fixed bytes.
 */
const KEY = Buffer.alloc(32, 0x42);
const KEY2 = Buffer.alloc(32, 0x43);
const keys = (active = "k1") => new LocalKeyProvider({ keys: { k1: KEY.toString("base64"), k2: KEY2.toString("base64") }, active });

const CONFIG: EncryptionConfig = {
  fields: { "test.Patient": { mrn: { mode: "deterministic" }, dob: {} } },
  actions: { Admit: { type: "test.Patient", idField: "id" }, Touch: null }
};
const PATIENTS: Record<string, Record<string, unknown>> = {
  p1: { id: "p1", name: "Ada", mrn: "MRN-1", dob: "1980-01-01" },
  p2: { id: "p2", name: "Bo", mrn: "MRN-2", dob: "1990-02-02" }
};

/**
 * A `tsenc1` envelope, built from ADR-0033's format: AES-256-GCM under the
 * HKDF subkey `["tsenc1","aes-256-gcm"]`, with `["tsenc1", type, field,
 * keyId]` as additional data. What a store written before ADR-0035 holds.
 */
function legacyEnvelope(type: string, field: string, value: unknown, keyId = "k1", material = KEY): string {
  const subkey = Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), JSON.stringify(["tsenc1", "aes-256-gcm"]), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subkey, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(JSON.stringify(["tsenc1", type, field, keyId]), "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `tsenc1.${keyId}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

async function world(config: EncryptionConfig = CONFIG, provider = keys()) {
  const inner = new InMemoryRepositoryAdapter("ds");
  const adapter = new EncryptingAdapter(inner, provider, config);
  for (const [id, values] of Object.entries(PATIENTS)) inner.seed("test.Patient", [{ objectId: id, values: await adapter.seal("test.Patient", id, values) }]);
  const stored = async (id: string) => (await inner.resolveProperties("test.Patient", id, [])).values;
  const put = (id: string, values: Record<string, unknown>) => inner.seed("test.Patient", [{ objectId: id, values }]);
  const read = (id: string) => adapter.resolveProperties("test.Patient", id, []).then((r) => r.values);
  return { inner, adapter, stored, put, read };
}

/** A store written before ADR-0035: every encrypted field an unbound tsenc1 envelope, deterministic ones indexed as before. */
async function legacyWorld(config: EncryptionConfig = CONFIG) {
  const w = await world(config);
  for (const [id, values] of Object.entries(PATIENTS)) {
    const current = await w.stored(id);
    w.put(id, { ...current, mrn: legacyEnvelope("test.Patient", "mrn", values.mrn), dob: legacyEnvelope("test.Patient", "dob", values.dob) });
  }
  return w;
}

describe("record-bound envelopes (ADR-0035)", () => {
  it("seal writes tsenc2, and a record reads back its own values", async () => {
    const { stored, read } = await world();
    expect((await stored("p1")).dob).toMatch(/^tsenc2\.k1\./);
    expect(await read("p1")).toEqual(PATIENTS.p1);
  });

  it("seal refuses a write that doesn't name its record", async () => {
    const { adapter } = await world();
    for (const id of ["", undefined, null, 7]) {
      await expect(adapter.seal("test.Patient", id as unknown as string, { dob: "x" })).rejects.toBeInstanceOf(EncryptedFieldError);
    }
  });

  describe("attack: moving ciphertext between records", () => {
    it("one field moved to another record fails authentication", async () => {
      const { stored, put, read } = await world();
      put("p2", { ...(await stored("p2")), dob: (await stored("p1")).dob });
      await expect(read("p2")).rejects.toThrow(/dob of "p2" failed authentication/);
    });

    it("a whole record copied under another id fails on every encrypted field", async () => {
      const { stored, put, read } = await world();
      put("p3", { ...(await stored("p1")), id: "p3" });
      await expect(read("p3")).rejects.toBeInstanceOf(DecryptionError);
    });

    it("an id that differs only in case or whitespace is a different record", async () => {
      const { adapter } = await world();
      const sealed = await adapter.seal("test.Patient", "PT-1001", { dob: "1980-01-01" });
      const inner = new InMemoryRepositoryAdapter("ds");
      const reader = new EncryptingAdapter(inner, keys(), CONFIG);
      for (const id of ["pt-1001", "PT-1001 ", " PT-1001"]) {
        inner.seed("test.Patient", [{ objectId: id, values: sealed }]);
        await expect(reader.resolveProperties("test.Patient", id, [])).rejects.toBeInstanceOf(DecryptionError);
      }
    });

    it("contexts that would collide under a delimiter don't collide under the JSON encoding", async () => {
      // "a|b"/"c" and "a"/"b|c" join to the same string with "|"; as JSON arrays they differ.
      const config: EncryptionConfig = { fields: { "a|b": { c: {} }, a: { "b|c": {} } }, actions: {} };
      const inner = new InMemoryRepositoryAdapter("ds");
      const adapter = new EncryptingAdapter(inner, keys(), config);
      const sealed = await adapter.seal("a|b", "x", { c: "secret" });
      inner.seed("a", [{ objectId: "x", values: { "b|c": sealed.c } }]);
      await expect(adapter.resolveProperties("a", "x", [])).rejects.toBeInstanceOf(DecryptionError);
    });
  });

  describe("legacy tsenc1 envelopes", () => {
    it("are refused by default, with a pointer to reseal", async () => {
      const { read } = await legacyWorld();
      await expect(read("p1")).rejects.toThrow(/unbound tsenc1 envelope, refused outside a migration; reseal it/);
    });

    it("attack: downgrading a bound value to another record's unbound ciphertext is refused by default", async () => {
      const { stored, put, read } = await world();
      // A tsenc1 dob that some other, older record once held — valid under a key the ring still has.
      put("p2", { ...(await stored("p2")), dob: legacyEnvelope("test.Patient", "dob", "1980-01-01") });
      await expect(read("p2")).rejects.toThrow(/unbound tsenc1/);
    });

    it("pinned migration-window risk: while legacy reads are on, that downgrade is accepted", async () => {
      const { stored, put, read } = await world({ ...CONFIG, legacyUnboundEnvelopes: "read" });
      put("p2", { ...(await stored("p2")), dob: legacyEnvelope("test.Patient", "dob", "1980-01-01") });
      expect((await read("p2")).dob).toBe("1980-01-01");
    });

    it("reseal migrates a record to tsenc2 under the active key, readable with legacy reads off, indexes intact", async () => {
      const { adapter, stored, put, read } = await legacyWorld();
      for (const id of ["p1", "p2"]) put(id, await adapter.reseal("test.Patient", id, await stored(id)));
      expect((await stored("p1")).dob).toMatch(/^tsenc2\.k1\./);
      expect(await read("p1")).toEqual(PATIENTS.p1);
      const lookup = await adapter.queryByType("test.Patient", { property: "mrn", operator: "eq", value: "MRN-2" });
      expect(lookup.items.map((i) => i.objectId)).toEqual(["p2"]);
    });

    it("reseal re-encrypts under a rotated key, and can't launder a ciphertext already bound to another record", async () => {
      const { stored, put, read } = await world();
      const rotated = new EncryptingAdapter(new InMemoryRepositoryAdapter("unused"), keys("k2"), CONFIG);
      const resealed = await rotated.reseal("test.Patient", "p1", await stored("p1"));
      expect(resealed.dob).toMatch(/^tsenc2\.k2\./);
      put("p1", resealed);
      expect(await read("p1")).toEqual(PATIENTS.p1);

      const swapped = { ...(await stored("p2")), dob: (await stored("p1")).dob };
      await expect(rotated.reseal("test.Patient", "p2", swapped)).rejects.toBeInstanceOf(DecryptionError);
    });
  });

  describe("Actions name the record they write", () => {
    const ctx = {} as ActionContext;
    const admit = { name: "Admit" } as ActionDefinition;

    it("an input carrying encrypted fields but no id is refused before the adapter runs", async () => {
      const inner = new InMemoryRepositoryAdapter("ds");
      let called = 0;
      inner.executeAction = async () => (called++, {});
      const adapter = new EncryptingAdapter(inner, keys(), CONFIG);
      for (const input of [{ dob: "1980-01-01" }, { id: "", dob: "x" }, { id: 7, mrn: "x" }]) {
        await expect(adapter.executeAction(admit, input, ctx)).rejects.toThrow(/carries no record id in "id"/);
      }
      expect(called).toBe(0);
    });

    it("an input with no encrypted field needs no id; its result is unsealed as the record it names", async () => {
      const inner = new InMemoryRepositoryAdapter("ds");
      const adapter = new EncryptingAdapter(inner, keys(), CONFIG);
      const stored = await adapter.seal("test.Patient", "p9", { id: "p9", dob: "1999-09-09" });
      inner.executeAction = async () => ({ ...stored, [`${BLIND_INDEX_PREFIX}extra`]: "x" });
      await expect(adapter.executeAction(admit, { note: "no protected fields here" }, ctx)).resolves.toEqual({ id: "p9", dob: "1999-09-09" });
    });

    it("the input is sealed under the id it names, so the adapter stores ciphertext bound to that record", async () => {
      const inner = new InMemoryRepositoryAdapter("ds");
      inner.executeAction = async (_a, input) => {
        const values = input as Record<string, unknown>;
        inner.seed("test.Patient", [{ objectId: String(values.id), values }]);
        return values;
      };
      const adapter = new EncryptingAdapter(inner, keys(), CONFIG);
      await expect(adapter.executeAction(admit, { id: "p5", name: "Cy", dob: "2000-01-01" }, ctx)).resolves.toEqual({ id: "p5", name: "Cy", dob: "2000-01-01" });
      expect((await inner.resolveProperties("test.Patient", "p5", [])).values.dob).toMatch(/^tsenc2\./);
      expect((await adapter.resolveProperties("test.Patient", "p5", [])).values.dob).toBe("2000-01-01");
    });

    it("a malformed Action mapping or legacy setting is refused up front", () => {
      const inner = new InMemoryRepositoryAdapter("ds");
      const bad = (config: Partial<EncryptionConfig>) => () => new EncryptingAdapter(inner, keys(), { fields: {}, ...config });
      expect(bad({ actions: { A: "test.Patient" as never } })).toThrow(EncryptionConfigError);
      expect(bad({ actions: { A: { type: "test.Patient", idField: "" } } })).toThrow(/\{ type, idField \}/);
      expect(bad({ legacyUnboundEnvelopes: "sometimes" as never })).toThrow(/legacyUnboundEnvelopes/);
    });
  });
});
