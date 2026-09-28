/**
 * A small, swappable rate-limiting seam (see ADR-0019) — the same pattern
 * as `Adapter`/`RegistryStore`/`PolicyEngine`/`Cache`: one interface, one
 * in-memory implementation built now, a distributed backend (Redis, etc.)
 * a documented-not-built extension point for a multi-process deployment.
 */
export interface RateLimiter {
  /** Returns true if this call may proceed, false if the caller should be rejected. */
  tryAcquire(key: string): boolean;
}

/** Never limits — what every `SemanticRuntime` uses when no `RateLimiter` is supplied, preserving pre-ADR-0019 behavior exactly. */
export class NoopRateLimiter implements RateLimiter {
  tryAcquire(): boolean {
    return true;
  }
}

export interface TokenBucketRateLimiterConfig {
  /** Maximum burst size (tokens available with no prior use). */
  capacity: number;
  /** Steady-state allowance: tokens added back per second. */
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * A per-key token bucket, in-process only — same scoping caveat as
 * `InMemoryCache`: a multi-instance deployment needs a shared store to
 * rate-limit consistently across processes, since each process otherwise
 * enforces its own independent budget for the same key.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: TokenBucketRateLimiterConfig) {}

  tryAcquire(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.config.capacity, lastRefillMs: now };

    const elapsedSeconds = Math.max(0, now - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(this.config.capacity, bucket.tokens + elapsedSeconds * this.config.refillPerSecond);
    bucket.lastRefillMs = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }
}
