import { afterEach, describe, it, expect, vi } from "vitest";
import { AbacPolicyEngine, InMemoryCache, InMemoryRegistryStore, SemanticRegistry, SemanticRuntime, allowAllRule, type Cache, type Identity } from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { DecryptionError, EncryptedCache, EncryptingAdapter, LocalKeyProvider } from "../src/index.js";

/**
 * ADR-0036: `EncryptedCache` makes any cache confidential — values sealed
 * and bound to their cache key and expiry, cache keys hidden behind an
 * HMAC, and anything that fails to decrypt a miss. Real `node:crypto`
 * throughout; keys are fixed bytes.
 */
const K1 = Buffer.alloc(32, 0x51).toString("base64");
const K2 = Buffer.alloc(32, 0x52).toString("base64");
const ring = (active: string, keys: Record<string, string> = { k1: K1, k2: K2 }) => new LocalKeyProvider({ keys, active });

/** A shared, non-confidential store — Redis's part — that exposes its raw entries. */
class RawStore implements Cache {
  readonly confidential = false;
  readonly entries = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
  async clear(): Promise<void> {
    this.entries.clear();
  }
}

function world(active = "k1") {
  const store = new RawStore();
  const errors: DecryptionError[] = [];
  const cache = new EncryptedCache(store, ring(active), { onError: (err) => errors.push(err) });
  /** The one raw entry the store holds. */
  const raw = () => [...store.entries][0]!;
  return { store, errors, cache, raw };
}

const KEY = "prop:patients:hospital.Patient:PT-1001";
const VALUE = { values: { id: "PT-1001", ssn: "123-45-6789" }, provenance: [] };

afterEach(() => {
  vi.useRealTimers();
});

describe("EncryptedCache (ADR-0036)", () => {
  it("is confidential, and round-trips every JSON value it's given", async () => {
    const { cache } = world();
    expect(cache.confidential).toBe(true);
    for (const value of [VALUE, ["a", 1], "text", 0, false, null]) {
      await cache.set("k", value, 60_000);
      expect(await cache.get("k")).toEqual(value);
    }
  });

  it("stores neither the value nor the cache key in the clear, and nothing for undefined", async () => {
    const { store, cache, raw } = world();
    await cache.set("skip", undefined, 60_000);
    expect(store.entries.size).toBe(0);
    await cache.set(KEY, VALUE, 60_000);
    const [name, entry] = raw();
    expect(name).toMatch(/^tscache1\.[A-Za-z0-9_-]{43}$/);
    expect(entry).toMatch(/^tscache1\.k1\.\d+\./);
    for (const leak of ["hospital", "PT-1001", "123-45-6789", "patients"]) expect(`${name} ${String(entry)}`).not.toContain(leak);
  });

  it("two writes of the same value never store the same ciphertext", async () => {
    const { cache, raw } = world();
    await cache.set(KEY, VALUE, 60_000);
    const first = raw()[1];
    await cache.set(KEY, VALUE, 60_000);
    expect(raw()[1]).not.toBe(first);
  });

  describe("attack: whoever can write the store", () => {
    it("can't move an entry to another cache key: it fails authentication and is a miss", async () => {
      const { store, cache, errors, raw } = world();
      await cache.set("prop:ds:hospital.Patient:PT-2002", { values: { ssn: "000" } }, 60_000);
      const [, entry] = raw();
      await cache.set(KEY, VALUE, 60_000);
      const target = [...store.entries.keys()].find((k) => store.entries.get(k) !== entry)!;
      store.entries.set(target, entry);
      expect(await cache.get(KEY)).toBeUndefined();
      expect(errors.map((e) => e.message)).toEqual(["a cache entry failed authentication: tampered, moved to another key, or under a different key"]);
    });

    it("can't tamper with an entry, extend its expiry, or truncate it", async () => {
      const { store, cache, errors, raw } = world();
      await cache.set(KEY, VALUE, 60_000);
      const [name, entry] = raw() as [string, string];
      const [version, keyId, expiry, iv, body] = entry.split(".") as [string, string, string, string, string];
      const flipped = body.slice(0, 10) + (body[10] === "A" ? "B" : "A") + body.slice(11);
      for (const forged of [
        [version, keyId, expiry, iv, flipped].join("."),
        [version, keyId, String(Number(expiry) + 86_400_000), iv, body].join("."),
        [version, keyId, expiry, iv, body.slice(0, 8)].join(".")
      ]) {
        store.entries.set(name, forged);
        expect(await cache.get(KEY)).toBeUndefined();
      }
      expect(errors).toHaveLength(3);
      expect(errors.every((e) => e instanceof DecryptionError)).toBe(true);
    });

    it("can't serve an entry past the expiry it was written with, even by putting it back", async () => {
      vi.useFakeTimers({ now: new Date("2026-09-30T00:00:00Z") });
      const { store, cache, errors, raw } = world();
      await cache.set(KEY, VALUE, 1_000);
      const [name, entry] = raw();
      vi.setSystemTime(new Date("2026-09-30T00:00:01Z"));
      store.entries.set(name, entry); // "expired" in the store's own view, restored anyway
      expect(await cache.get(KEY)).toBeUndefined();
      expect(errors).toEqual([]); // an expired entry is an ordinary miss
    });

    it("pinned residual: within its TTL, an invalidated entry put back is served (the staleness the TTL allows)", async () => {
      const { store, cache, raw } = world();
      await cache.set(KEY, VALUE, 60_000);
      const [name, entry] = raw();
      await cache.delete(KEY);
      expect(await cache.get(KEY)).toBeUndefined();
      store.entries.set(name, entry);
      expect(await cache.get(KEY)).toEqual(VALUE);
    });

    it("can't substitute anything that isn't an entry sealed under a key in the ring", async () => {
      const { store, cache, errors } = world();
      await cache.set(KEY, VALUE, 60_000);
      const name = [...store.entries.keys()][0]!;
      const field = await new EncryptingAdapter(new InMemoryRepositoryAdapter("x"), ring("k1"), { fields: { T: { f: {} } }, actions: {} }).seal("T", "o", { f: VALUE });

      // An entry from a cache under different key material that happens to share the key id.
      const other = world();
      const impostor = new EncryptedCache(other.store, ring("k1", { k1: Buffer.alloc(32, 0x99).toString("base64") }));
      await impostor.set(KEY, { values: { ssn: "forged" } }, 60_000);

      for (const substitute of [field.f, JSON.stringify(VALUE), VALUE, "tscache1.gone.9999999999999.AAAAAAAAAAAAAAAA.AAAA", [...other.store.entries.values()][0]]) {
        store.entries.set(name, substitute);
        expect(await cache.get(KEY)).toBeUndefined();
      }
      expect(errors.map((e) => e.message)).toEqual([
        "a cache entry is not an EncryptedCache entry",
        "a cache entry is not an EncryptedCache entry",
        "a cache entry is not an EncryptedCache entry",
        `a cache entry is under key "gone", which the keyring doesn't hold`,
        "a cache entry failed authentication: tampered, moved to another key, or under a different key"
      ]);
    });
  });

  describe("rotation", () => {
    it("delete removes an entry under every key in the ring, so invalidation lands across a rotation", async () => {
      const store = new RawStore();
      const before = new EncryptedCache(store, ring("k1"));
      const after = new EncryptedCache(store, ring("k2"));
      await before.set(KEY, VALUE, 60_000);
      expect(await after.get(KEY)).toBeUndefined(); // written under k1's key name: after rotation, a miss
      await after.set(KEY, VALUE, 60_000);
      expect(store.entries.size).toBe(2);
      await after.delete(KEY);
      expect(store.entries.size).toBe(0);
      expect(await before.get(KEY)).toBeUndefined();
    });

    it("clear clears the store beneath it", async () => {
      const { store, cache } = world();
      await cache.set(KEY, VALUE, 60_000);
      await cache.clear();
      expect(store.entries.size).toBe(0);
    });
  });

  describe("under the runtime, over an EncryptingAdapter", () => {
    async function runtimeWith(cache: Cache) {
      const registry = new SemanticRegistry(new InMemoryRegistryStore());
      await registry.registerType(
        {
          $id: "https://typesys.dev/types/test/Patient/1.0.0",
          type: "object",
          title: "Patient",
          properties: { id: { type: "string" }, name: { type: "string" }, ssn: { type: "string" } },
          "x-policy": { objectPolicy: "public" }
        },
        { name: "test.Patient", version: "1.0.0" }
      );
      await registry.registerMapping({ id: "map-p", typeName: "test.Patient", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "cached", cacheTtlMs: 60_000 });
      const inner = new InMemoryRepositoryAdapter("ds");
      const adapter = new EncryptingAdapter(inner, ring("k1"), { fields: { "test.Patient": { ssn: {} } }, actions: {} });
      inner.seed("test.Patient", [{ objectId: "p1", values: await adapter.seal("test.Patient", "p1", { id: "p1", name: "Ada Lovelace", ssn: "123-45-6789" }) }]);
      let reads = 0;
      const resolve = inner.resolveProperties.bind(inner);
      inner.resolveProperties = (...args) => (reads++, resolve(...args));
      const policyEngine = new AbacPolicyEngine();
      policyEngine.registerRule("public", allowAllRule);
      return { runtime: new SemanticRuntime(registry, [adapter], policyEngine, { cache }), reads: () => reads };
    }
    const anyone: Identity = { subjectId: "u", roles: [], attributes: {} };

    it("the adapter declares its encrypted fields, so a bare shared cache is bypassed and holds nothing", async () => {
      const store = new RawStore();
      const { runtime, reads } = await runtimeWith(store);
      for (let i = 0; i < 3; i++) expect((await runtime.getObject("test.Patient", "p1", anyone)).values.ssn).toBe("123-45-6789");
      expect(reads()).toBe(3);
      expect(store.entries.size).toBe(0);
    });

    it("wrapped in EncryptedCache, the same shared cache serves the Type — and holds no plaintext", async () => {
      const store = new RawStore();
      const { runtime, reads } = await runtimeWith(new EncryptedCache(store, ring("k1")));
      for (let i = 0; i < 3; i++) expect((await runtime.getObject("test.Patient", "p1", anyone)).values.ssn).toBe("123-45-6789");
      expect(reads()).toBe(1);
      expect(store.entries.size).toBe(1);
      expect(JSON.stringify([...store.entries])).not.toMatch(/123-45-6789|Lovelace|test\.Patient/);
    });

    it("an in-process cache needs no wrapper", async () => {
      const { runtime, reads } = await runtimeWith(new InMemoryCache());
      for (let i = 0; i < 3; i++) await runtime.getObject("test.Patient", "p1", anyone);
      expect(reads()).toBe(1);
    });
  });
});
