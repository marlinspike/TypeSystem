import type { Cache } from "@typesys/core";
import { escapeGlob, type RedisCommands } from "./client.js";

export interface RedisCacheOptions {
  /** Namespaces every key, so several runtimes (or environments) can share one Redis. Default `"typesys:cache:"`. */
  keyPrefix?: string;
  /**
   * Called when a `get` or `set` fails. Those two degrade instead of throwing — a read becomes a
   * cache miss, a write is skipped — so a Redis outage slows reads down rather than failing them.
   * Defaults to `console.warn`. `delete`/`clear` still throw: a failed invalidation means stale data.
   */
  onError?: (err: unknown, operation: "get" | "set") => void;
}

/**
 * A `Cache` (ADR-0016) shared by every runtime instance pointed at the same
 * Redis, so one instance's `invalidateObject` is seen by all of them
 * (ADR-0025). Values are stored as JSON: adapter output and computed values
 * must be JSON-serializable (a `Date`, for example, comes back as a string).
 * Not confidential (ADR-0036): the runtime keeps encrypted and marked data
 * out of it unless it is wrapped in `EncryptedCache`.
 */
export class RedisCache implements Cache {
  readonly confidential = false;
  private readonly prefix: string;
  private readonly onError: (err: unknown, operation: "get" | "set") => void;

  constructor(
    private readonly client: RedisCommands,
    opts: RedisCacheOptions = {}
  ) {
    this.prefix = opts.keyPrefix ?? "typesys:cache:";
    this.onError = opts.onError ?? ((err, op) => console.warn(`RedisCache ${op} failed; continuing without the cache:`, err));
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.client.get(this.prefix + key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (err) {
      this.onError(err, "get");
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    // JSON has no `undefined`, and the runtime treats undefined as "not cached" anyway.
    if (value === undefined) return;
    try {
      await this.client.set(this.prefix + key, JSON.stringify(value), { expiration: { type: "PX", value: Math.max(1, Math.round(ttlMs)) } });
    } catch (err) {
      this.onError(err, "set");
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }

  /** Removes every key under this cache's prefix (and nothing else), in batches via `SCAN`. */
  async clear(): Promise<void> {
    for await (const keys of this.client.scanIterator({ MATCH: `${escapeGlob(this.prefix)}*`, COUNT: 500 })) {
      if (keys.length > 0) await this.client.del(keys);
    }
  }
}
