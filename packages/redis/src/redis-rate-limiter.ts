import type { RateLimiter } from "@typesys/core";
import type { RedisCommands } from "./client.js";

export interface RedisRateLimiterOptions {
  /** Burst size: the most calls one key can make back to back. */
  capacity: number;
  /** Steady-state tokens added per second. 0 means the bucket never refills (and its key never expires). */
  refillPerSecond: number;
  /** Namespaces every key. Default `"typesys:ratelimit:"`. */
  keyPrefix?: string;
  /**
   * What to do when Redis can't be reached. `false` (the default) rethrows, so the runtime call fails
   * with the real error rather than a misleading "rate limit exceeded". `true` allows the call —
   * availability over enforcement — and reports the error to `onError`.
   */
  failOpen?: boolean;
  onError?: (err: unknown) => void;
}

/**
 * The same token bucket as `InMemoryRateLimiter`, evaluated atomically in
 * Redis so every instance draws from one budget per key. The clock is
 * Redis's own `TIME`, not each instance's, so skew between hosts can't hand
 * out extra tokens.
 */
const TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local perMs = tonumber(ARGV[2]) / 1000
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
if now > ts then
  tokens = math.min(capacity, tokens + (now - ts) * perMs)
end
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
if perMs > 0 then
  redis.call('PEXPIRE', key, math.ceil(capacity / perMs) + 1000)
end
return allowed
`;

/** A `RateLimiter` (ADR-0019) whose budget is shared by every runtime instance on the same Redis (ADR-0025). */
export class RedisRateLimiter implements RateLimiter {
  private readonly prefix: string;

  constructor(
    private readonly client: RedisCommands,
    private readonly opts: RedisRateLimiterOptions
  ) {
    if (!(opts.capacity >= 1)) throw new RangeError("RedisRateLimiter capacity must be at least 1");
    if (!(opts.refillPerSecond >= 0)) throw new RangeError("RedisRateLimiter refillPerSecond must be 0 or more");
    this.prefix = opts.keyPrefix ?? "typesys:ratelimit:";
  }

  async tryAcquire(key: string): Promise<boolean> {
    try {
      const allowed = await this.client.eval(TOKEN_BUCKET, {
        keys: [this.prefix + key],
        arguments: [String(this.opts.capacity), String(this.opts.refillPerSecond)]
      });
      return allowed === 1;
    } catch (err) {
      if (!this.opts.failOpen) throw err;
      (this.opts.onError ?? ((e) => console.warn("RedisRateLimiter unavailable; allowing the call (failOpen):", e)))(err);
      return true;
    }
  }
}
