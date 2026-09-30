import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { InMemoryCache } from "@typesys/core";
import { EncryptedCache, EncryptingAdapter, EncryptionConfigError, KeyUnavailableError, newWrappedKey, WrappedKeyProvider, type KeyEncryptionKey, type WrappedKeyOptions } from "../src/index.js";

/**
 * ADR-0037: a keyring of data keys wrapped by a KMS key — unwrapped at
 * startup or not at all, then leased so that revoking the KMS key stops
 * every use within `maxKeyAgeMs`, while a shorter KMS outage is invisible.
 * The KMS here is a fake with real AES-GCM wrapping bound to the key id.
 */
class FakeKms implements KeyEncryptionKey {
  readonly name = "fake-kms:test";
  available = true;
  unwraps = 0;
  /** While set, every unwrap waits for it — a slow KMS. */
  stall: Promise<void> | undefined;
  private readonly master = randomBytes(32);

  wrap(material: Uint8Array, keyId: string): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.master, iv).setAAD(Buffer.from(keyId));
    return Buffer.concat([iv, cipher.update(material), cipher.final(), cipher.getAuthTag()]);
  }
  async generateWrappedKey(keyId: string): Promise<Uint8Array> {
    return this.wrap(randomBytes(32), keyId);
  }
  async unwrap(wrapped: Uint8Array, keyId: string): Promise<Uint8Array> {
    this.unwraps++;
    await this.stall;
    if (!this.available) throw new Error("AccessDeniedException: the key is disabled");
    const blob = Buffer.from(wrapped);
    const decipher = createDecipheriv("aes-256-gcm", this.master, blob.subarray(0, 12)).setAAD(Buffer.from(keyId));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
  }
}

const MINUTE = 60_000;
const LEASE: WrappedKeyOptions = { refreshAfterMs: 5 * MINUTE, maxKeyAgeMs: 15 * MINUTE, retryIntervalMs: 30_000 };

async function world(options: WrappedKeyOptions = {}) {
  const kms = new FakeKms();
  let clock = 1_000_000;
  const refreshErrors: KeyUnavailableError[] = [];
  const keyring = { keys: { "2026-09": await newWrappedKey(kms, "2026-09"), "2026-06": await newWrappedKey(kms, "2026-06") }, active: "2026-09" };
  const provider = await WrappedKeyProvider.open(kms, keyring, { ...LEASE, now: () => clock, onRefreshError: (e) => refreshErrors.push(e), ...options });
  kms.unwraps = 0;
  const inner = new InMemoryRepositoryAdapter("ds");
  const adapter = new EncryptingAdapter(inner, provider, { fields: { "test.Patient": { ssn: { mode: "deterministic" } } }, actions: {} });
  inner.seed("test.Patient", [{ objectId: "p1", values: await adapter.seal("test.Patient", "p1", { id: "p1", ssn: "123-45-6789" }) }]);
  const read = async () => (await adapter.resolveProperties("test.Patient", "p1", [])).values.ssn;
  const advance = (ms: number) => (clock += ms);
  /** Lets a background refresh settle. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { kms, keyring, provider, adapter, read, advance, settle, refreshErrors };
}

describe("WrappedKeyProvider (ADR-0037)", () => {
  it("unwraps a ring minted through the KMS, and encrypts and decrypts under it", async () => {
    const { provider, read, keyring } = await world();
    expect((await provider.activeKey()).id).toBe("2026-09");
    expect((await provider.allKeys()).map((k) => k.id)).toEqual(["2026-09", "2026-06"]);
    expect(await read()).toBe("123-45-6789");
    // What's in configuration is wrapped: not 32 bytes of key, and not the unwrapped material.
    const unwrapped = Buffer.from((await provider.activeKey()).material).toString("base64");
    expect(Buffer.from(keyring.keys["2026-09"], "base64").length).toBeGreaterThan(32);
    expect(keyring.keys["2026-09"]).not.toContain(unwrapped);
  });

  it("reads a ring of wrapped keys from the environment, the active key first", async () => {
    const kms = new FakeKms();
    const env = { TYPESYS_WRAPPED_KEYS: `b:${await newWrappedKey(kms, "b")},a:${await newWrappedKey(kms, "a")}` };
    const provider = await WrappedKeyProvider.fromEnv(kms, env);
    expect((await provider.allKeys()).map((k) => k.id)).toEqual(["b", "a"]);
  });

  describe("attack: startup refuses keys it can't have", () => {
    it("a KMS that can't be reached, or has disabled the key, fails open() — the process never starts", async () => {
      const { kms, keyring } = await world();
      kms.available = false;
      await expect(WrappedKeyProvider.open(kms, keyring)).rejects.toThrow(KeyUnavailableError);
      await expect(WrappedKeyProvider.open(kms, keyring)).rejects.toThrow(/Key "2026-0[69]" could not be unwrapped by fake-kms:test/);
    });

    it("one retired key that won't unwrap fails the whole ring", async () => {
      const { kms, keyring } = await world();
      const other = new FakeKms();
      const ring = { ...keyring, keys: { ...keyring.keys, "2026-06": await newWrappedKey(other, "2026-06") } };
      await expect(WrappedKeyProvider.open(kms, ring)).rejects.toThrow(/Key "2026-06" could not be unwrapped/);
    });

    it("a wrapped key relabeled as another id doesn't unwrap", async () => {
      const { kms, keyring } = await world();
      const relabeled = { active: "2026-09", keys: { "2026-09": keyring.keys["2026-06"] } };
      await expect(WrappedKeyProvider.open(kms, relabeled)).rejects.toThrow(/Key "2026-09" could not be unwrapped/);
    });

    it("a KMS handing back something that isn't a 32-byte key is refused", async () => {
      const kms = new FakeKms();
      const short = Buffer.from(kms.wrap(randomBytes(16), "k")).toString("base64");
      await expect(WrappedKeyProvider.open(kms, { keys: { k: short }, active: "k" })).rejects.toThrow(/is not a 32-byte key/);
    });

    it("a malformed ring or lease is refused before the KMS is asked", async () => {
      const kms = new FakeKms();
      const good = await newWrappedKey(kms, "k");
      kms.unwraps = 0;
      await expect(WrappedKeyProvider.open(kms, { keys: { k: good }, active: "missing" })).rejects.toThrow(EncryptionConfigError);
      await expect(WrappedKeyProvider.open(kms, { keys: { "bad id": good }, active: "bad id" })).rejects.toThrow(EncryptionConfigError);
      await expect(WrappedKeyProvider.open(kms, { keys: { k: "not base64!" }, active: "k" })).rejects.toThrow(EncryptionConfigError);
      for (const lease of [{ refreshAfterMs: 0 }, { maxKeyAgeMs: Number.NaN }, { retryIntervalMs: -1 }, { refreshAfterMs: 10, maxKeyAgeMs: 10 }]) {
        await expect(WrappedKeyProvider.open(kms, { keys: { k: good }, active: "k" }, lease)).rejects.toThrow(EncryptionConfigError);
      }
      expect(kms.unwraps).toBe(0);
    });
  });

  describe("the lease", () => {
    it("within refreshAfterMs, using the keys never calls the KMS", async () => {
      const { kms, read, advance } = await world();
      advance(5 * MINUTE - 1);
      for (let i = 0; i < 20; i++) await read();
      expect(kms.unwraps).toBe(0);
    });

    it("after refreshAfterMs, one background refresh for every concurrent use — and no use waits for it", async () => {
      const { kms, read, advance, settle } = await world();
      let release!: () => void;
      kms.stall = new Promise((resolve) => (release = resolve));
      advance(5 * MINUTE);
      const reads = await Promise.all(Array.from({ length: 10 }, read)); // resolves while the KMS is stalled
      expect(reads.every((v) => v === "123-45-6789")).toBe(true);
      expect(kms.unwraps).toBe(2); // one refresh: both keys, once
      release();
      await settle();
      advance(4 * MINUTE); // the renewed lease runs from the refresh
      await read();
      expect(kms.unwraps).toBe(2);
    });

    it("past maxKeyAgeMs, a use waits for the refresh and carries on under the renewed lease", async () => {
      const { kms, read, advance } = await world();
      advance(15 * MINUTE);
      expect(await read()).toBe("123-45-6789");
      expect(kms.unwraps).toBe(2);
    });
  });

  describe("attack: revoking the KMS key", () => {
    it("keeps working through the lease, then fails closed — reads, writes, lookups, and the cache", async () => {
      const { kms, provider, adapter, read, advance, settle, refreshErrors } = await world();
      const cache = new EncryptedCache(new InMemoryCache(), provider);
      await cache.set("k", "v", 60 * MINUTE);
      const lookup = () => adapter.queryByType("test.Patient", { property: "ssn", operator: "eq", value: "123-45-6789" });
      expect((await lookup()).items.map((i) => i.objectId)).toEqual(["p1"]);
      kms.available = false;

      advance(5 * MINUTE);
      expect(await read()).toBe("123-45-6789"); // a KMS blip within the lease is invisible
      await settle();
      expect(refreshErrors).toHaveLength(1);

      advance(10 * MINUTE); // maxKeyAgeMs since the last successful unwrap
      await expect(read()).rejects.toThrow(KeyUnavailableError);
      await expect(read()).rejects.toThrow(/past maxKeyAgeMs and could not be refreshed/);
      await expect(adapter.seal("test.Patient", "p2", { ssn: "x" })).rejects.toThrow(KeyUnavailableError);
      await expect(lookup()).rejects.toThrow(KeyUnavailableError);
      await expect(cache.get("k")).rejects.toThrow(KeyUnavailableError);
      await expect(provider.allKeys()).rejects.toThrow(KeyUnavailableError);
    });

    it("an outage costs one KMS call per retryIntervalMs, not one per request", async () => {
      const { kms, read, advance, settle, refreshErrors } = await world();
      kms.available = false;
      advance(15 * MINUTE);
      await expect(read()).rejects.toThrow(KeyUnavailableError);
      const after = kms.unwraps;
      for (let i = 0; i < 20; i++) await expect(read()).rejects.toThrow(KeyUnavailableError);
      expect(kms.unwraps).toBe(after);
      advance(30_000);
      await expect(read()).rejects.toThrow(KeyUnavailableError);
      await settle();
      expect(kms.unwraps).toBeGreaterThan(after);
      expect(refreshErrors).toHaveLength(2);
    });

    it("once access is restored, the next attempt renews the lease", async () => {
      const { kms, read, advance } = await world();
      kms.available = false;
      advance(15 * MINUTE);
      await expect(read()).rejects.toThrow(KeyUnavailableError);
      kms.available = true;
      advance(30_000);
      expect(await read()).toBe("123-45-6789");
    });
  });
});
