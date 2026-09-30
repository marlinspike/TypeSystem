import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "redis";
import { EncryptedCache, LocalKeyProvider } from "@typesys/encryption";
import { RedisCache, RedisRateLimiter, type RedisCommands } from "../src/index.js";

const REDIS_URL = process.env.REDIS_URL;

describe("RedisCache confidentiality (ADR-0036)", () => {
  it("is not confidential, so the runtime keeps encrypted and marked data out of it", () => {
    expect(new RedisCache({} as RedisCommands).confidential).toBe(false);
  });
});

describe.skipIf(!REDIS_URL)("RedisCache and RedisRateLimiter (real Redis)", () => {
  const client = createClient({ url: REDIS_URL });
  // Unique per run, so parallel CI jobs or a developer's own data can't collide with these keys.
  const run = `typesys-test:${Date.now()}:${Math.random().toString(36).slice(2)}:`;

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await new RedisCache(client, { keyPrefix: run }).clear();
    await client.close();
  });

  describe("RedisCache", () => {
    it("round-trips JSON values and misses on unknown keys", async () => {
      const cache = new RedisCache(client, { keyPrefix: `${run}c1:` });
      await cache.set("obj", { values: { a: 1, nested: ["x"] }, provenance: [] }, 10_000);
      expect(await cache.get("obj")).toEqual({ values: { a: 1, nested: ["x"] }, provenance: [] });
      expect(await cache.get("nope")).toBeUndefined();
    });

    it("expires entries after their TTL", async () => {
      const cache = new RedisCache(client, { keyPrefix: `${run}c2:` });
      await cache.set("short", "v", 50);
      expect(await cache.get("short")).toBe("v");
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await cache.get("short")).toBeUndefined();
    });

    it("delete removes one key; clear removes only its own prefix", async () => {
      const mine = new RedisCache(client, { keyPrefix: `${run}c3:` });
      const other = new RedisCache(client, { keyPrefix: `${run}c3-other:` });
      await mine.set("a", 1, 10_000);
      await mine.set("b", 2, 10_000);
      await other.set("a", 3, 10_000);

      await mine.delete("a");
      expect(await mine.get("a")).toBeUndefined();
      expect(await mine.get("b")).toBe(2);

      await mine.clear();
      expect(await mine.get("b")).toBeUndefined();
      expect(await other.get("a")).toBe(3); // a prefix that merely starts the same is untouched
    });

    it("treats a prefix with glob characters literally when clearing", async () => {
      const tricky = new RedisCache(client, { keyPrefix: `${run}c4*[x]:` });
      const bystander = new RedisCache(client, { keyPrefix: `${run}c4-bystander:` });
      await tricky.set("k", 1, 10_000);
      await bystander.set("k", 2, 10_000);
      await tricky.clear();
      expect(await tricky.get("k")).toBeUndefined();
      expect(await bystander.get("k")).toBe(2);
    });

    it("wrapped in EncryptedCache (ADR-0036), round-trips values while Redis holds neither the value nor the key", async () => {
      const keys = new LocalKeyProvider({ keys: { k1: Buffer.alloc(32, 7).toString("base64") }, active: "k1" });
      const cache = new EncryptedCache(new RedisCache(client, { keyPrefix: `${run}c5:` }), keys);
      await cache.set("prop:ds:hospital.Patient:PT-1001", { values: { ssn: "123-45-6789" }, provenance: [] }, 10_000);
      expect(await cache.get("prop:ds:hospital.Patient:PT-1001")).toEqual({ values: { ssn: "123-45-6789" }, provenance: [] });
      const stored: string[] = [];
      for await (const batch of client.scanIterator({ MATCH: `${run}c5:*` })) {
        for (const key of batch) stored.push(key, String(await client.get(key)));
      }
      expect(stored).toHaveLength(2);
      expect(stored.join(" ")).not.toMatch(/123-45-6789|hospital|PT-1001/);
      await cache.delete("prop:ds:hospital.Patient:PT-1001");
      expect(await cache.get("prop:ds:hospital.Patient:PT-1001")).toBeUndefined();
    });
  });

  describe("RedisRateLimiter", () => {
    it("allows up to capacity, then rejects", async () => {
      const limiter = new RedisRateLimiter(client, { capacity: 3, refillPerSecond: 0, keyPrefix: `${run}r1:` });
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await limiter.tryAcquire("k"));
      expect(results).toEqual([true, true, true, false]);
    });

    it("refills over time", async () => {
      const limiter = new RedisRateLimiter(client, { capacity: 1, refillPerSecond: 20, keyPrefix: `${run}r2:` });
      expect(await limiter.tryAcquire("k")).toBe(true);
      expect(await limiter.tryAcquire("k")).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 120)); // 20/s = one token per 50ms
      expect(await limiter.tryAcquire("k")).toBe(true);
    });

    it("tracks each key independently", async () => {
      const limiter = new RedisRateLimiter(client, { capacity: 1, refillPerSecond: 0, keyPrefix: `${run}r3:` });
      expect(await limiter.tryAcquire("alice")).toBe(true);
      expect(await limiter.tryAcquire("alice")).toBe(false);
      expect(await limiter.tryAcquire("bob")).toBe(true);
    });

    it("hands out exactly capacity tokens under a concurrent burst (the Lua script is atomic)", async () => {
      const limiter = new RedisRateLimiter(client, { capacity: 10, refillPerSecond: 0, keyPrefix: `${run}r4:` });
      const results = await Promise.all(Array.from({ length: 50 }, () => limiter.tryAcquire("burst")));
      expect(results.filter(Boolean)).toHaveLength(10);
    });
  });
});

describe("Redis failure handling (no Redis needed)", () => {
  const broken: RedisCommands = {
    get: () => Promise.reject(new Error("down")),
    set: () => Promise.reject(new Error("down")),
    del: () => Promise.reject(new Error("down")),
    scanIterator: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("down")) })
    }),
    eval: () => Promise.reject(new Error("down"))
  };

  it("RedisCache degrades get/set to a miss and reports the error, but delete still throws", async () => {
    const errors: string[] = [];
    const cache = new RedisCache(broken, { onError: (_err, op) => errors.push(op) });
    await expect(cache.get("k")).resolves.toBeUndefined();
    await expect(cache.set("k", 1, 1000)).resolves.toBeUndefined();
    expect(errors).toEqual(["get", "set"]);
    await expect(cache.delete("k")).rejects.toThrow("down");
  });

  it("RedisRateLimiter fails closed by default and open only when asked", async () => {
    await expect(new RedisRateLimiter(broken, { capacity: 1, refillPerSecond: 1 }).tryAcquire("k")).rejects.toThrow("down");

    const seen: unknown[] = [];
    const open = new RedisRateLimiter(broken, { capacity: 1, refillPerSecond: 1, failOpen: true, onError: (e) => seen.push(e) });
    await expect(open.tryAcquire("k")).resolves.toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("rejects nonsensical limiter settings up front", () => {
    expect(() => new RedisRateLimiter(broken, { capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => new RedisRateLimiter(broken, { capacity: 1, refillPerSecond: -1 })).toThrow(RangeError);
  });
});
