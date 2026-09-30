import { describe, it, expect } from "vitest";
import { AbacPolicyEngine, HIGH_ASSURANCE_V1, InMemoryCache, InMemoryRegistryStore, SecurityProfileError, SemanticRegistry, SemanticRuntime, type Adapter, type Cache } from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { EncryptedCache, EncryptingAdapter, LocalKeyProvider, WrappedKeyProvider, newWrappedKey, type KeyEncryptionKey, type KeyProvider } from "../src/index.js";

/**
 * ADR-0046: under `HIGH_ASSURANCE_V1`, encryption keys must be managed — the
 * runtime refuses an `EncryptingAdapter` or `EncryptedCache` whose keys are
 * local, or whose provider doesn't say where its keys come from.
 */
const local = () => new LocalKeyProvider({ keys: { k1: Buffer.alloc(32, 1).toString("base64") }, active: "k1" });
/** A fake KMS key: it wraps with a fixed XOR, which is fine for proving where the keys come from. */
const kek: KeyEncryptionKey = {
  name: "fake-kms",
  generateWrappedKey: async () => new Uint8Array(32).fill(3),
  unwrap: async (wrapped) => new Uint8Array(wrapped).map((b) => b ^ 1)
};
const CONFIG = { fields: { "test.T": { secret: {} } }, actions: {} };
const start = (adapters: Adapter[], cache?: Cache) => new SemanticRuntime(new SemanticRegistry(new InMemoryRegistryStore()), adapters, new AbacPolicyEngine(), { securityProfile: HIGH_ASSURANCE_V1, ...(cache ? { cache } : {}) });

describe("keys under HIGH_ASSURANCE_V1 (ADR-0046)", () => {
  it("each encrypting component reports where its keys come from", async () => {
    const managed = await WrappedKeyProvider.open(kek, { keys: { k1: await newWrappedKey(kek, "k1") }, active: "k1" });
    expect(new EncryptingAdapter(new InMemoryRepositoryAdapter("ds"), local(), CONFIG).keyManagement).toBe("local");
    expect(new EncryptingAdapter(new InMemoryRepositoryAdapter("ds"), managed, CONFIG).keyManagement).toBe("managed");
    const anonymous: KeyProvider = { activeKey: () => local().activeKey(), keyById: (id) => local().keyById(id), allKeys: () => local().allKeys() };
    expect(new EncryptedCache(new InMemoryCache(), anonymous).keyManagement).toBe("unknown");
  });

  it("attack: local keys — for an adapter or a cache — or a provider that won't say, stop the runtime from starting", async () => {
    expect(() => start([new EncryptingAdapter(new InMemoryRepositoryAdapter("ds"), local(), CONFIG)])).toThrow(SecurityProfileError);
    expect(() => start([new InMemoryRepositoryAdapter("ds")], new EncryptedCache(new InMemoryCache(), local()))).toThrow(/the cache reports "local" key management/);
    const anonymous: KeyProvider = { activeKey: () => local().activeKey(), keyById: (id) => local().keyById(id), allKeys: () => local().allKeys() };
    expect(() => start([new EncryptingAdapter(new InMemoryRepositoryAdapter("ds"), anonymous, CONFIG)])).toThrow(/"unknown" key management/);
  });

  it("KMS-managed keys are accepted", async () => {
    const managed = await WrappedKeyProvider.open(kek, { keys: { k1: await newWrappedKey(kek, "k1") }, active: "k1" });
    expect(start([new EncryptingAdapter(new InMemoryRepositoryAdapter("ds"), managed, CONFIG)], new EncryptedCache(new InMemoryCache(), managed)).securityProfile).toBe("typesys:high-assurance:1");
  });
});
