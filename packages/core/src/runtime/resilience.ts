import { AdapterTimeoutError, CircuitOpenError } from "./errors.js";

/**
 * How an adapter call should retry, be time-bounded, and be circuit-broken
 * (see ADR-0026). Every field is optional, and omitting `resilience` from
 * `SemanticRuntimeOptions` entirely preserves the pre-ADR-0026 behavior
 * exactly — no timeout, no retry, no breaker — the same "defaults to how it
 * worked before the feature existed" rule the cache (ADR-0016) and rate
 * limiter (ADR-0019) follow.
 */
export interface RetryPolicy {
  /** Total attempts, including the first. `1` disables retrying. */
  maxAttempts: number;
  /** Backoff before the 2nd attempt; doubled each further attempt, capped at `maxDelayMs`, then jittered to 50–100%. */
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface CircuitBreakerPolicy {
  /** Consecutive failures against one data source that trip the breaker open. */
  failureThreshold: number;
  /** How long the breaker stays open before it allows one half-open probe. */
  cooldownMs: number;
}

export interface ResiliencePolicy {
  /** Per adapter-call deadline. On expiry the call's `AbortSignal` is aborted and an `AdapterTimeoutError` is thrown. */
  callTimeoutMs?: number;
  retry?: RetryPolicy;
  circuitBreaker?: CircuitBreakerPolicy;
}

/**
 * A documented starting point, **not** a default — pass it explicitly in
 * `SemanticRuntimeOptions.resilience` to opt in. Real values depend on real
 * adapter latency and real traffic (`PRODUCTION-READINESS.md` item 12); these
 * are only sane opening numbers.
 */
export const RECOMMENDED_RESILIENCE_POLICY: ResiliencePolicy = {
  callTimeoutMs: 10_000,
  retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 1_000 },
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000 }
};

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH"
]);

/**
 * Whether a failed adapter call is worth retrying. Deliberately conservative:
 * only a genuine transient signal counts — an error that carries
 * `retryable: true` (our `AdapterTimeoutError` / `AdapterUnavailableError`
 * do), a known transient network `code`, or nothing marking it non-retryable.
 * Domain errors (authorization, invalid input, not found, precondition) carry
 * no such marker and so never match, meaning a retry can't mask a real,
 * deterministic failure or silently re-audit a denial.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return false;
  if (err instanceof AdapterTimeoutError) return true;
  if (err && typeof err === "object") {
    const marked = (err as { retryable?: unknown }).retryable;
    if (marked === true) return true;
    if (marked === false) return false;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_ERROR_CODES.has(code)) return true;
  }
  return false;
}

type BreakerState = "closed" | "open" | "half-open";

/**
 * A three-state breaker per data source. Closed: calls pass. Open: calls
 * fast-fail until `cooldownMs` elapses. Half-open: one probe is allowed; its
 * success closes the breaker, its failure re-opens it. Kept intentionally
 * small — see ADR-0026's "Alternatives Considered" for why it is per process,
 * not shared across replicas.
 */
class CircuitBreaker {
  private failures = 0;
  private state: BreakerState = "closed";
  private openedAt = 0;

  constructor(
    private readonly policy: CircuitBreakerPolicy,
    private readonly now: () => number
  ) {}

  canAttempt(): boolean {
    if (this.state !== "open") return true;
    if (this.now() - this.openedAt >= this.policy.cooldownMs) {
      this.state = "half-open";
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failures++;
    // A failed half-open probe re-opens at once; otherwise open when the streak reaches the threshold.
    if (this.state === "half-open" || this.failures >= this.policy.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}

function backoffDelayMs(attempt: number, retry: RetryPolicy): number {
  const exponential = retry.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(retry.maxDelayMs, exponential);
  // Full-ish jitter (50–100% of the capped delay) so many callers retrying a
  // just-recovered backend don't re-synchronize into a thundering herd.
  return capped * (0.5 + Math.random() * 0.5);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps every adapter call the runtime makes (see ADR-0026 and
 * `SemanticRuntime.getAdapter`) with, per attempt: a per-`dataSourceId`
 * circuit breaker, a per-call deadline that aborts the call's `AbortSignal`,
 * and — for retryable calls only — retries with exponential backoff. Breaker
 * state is per instance, hence per process, consistent with the per-process
 * concurrency `Semaphore` (ADR-0025).
 */
export class AdapterResilience {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly policy: ResiliencePolicy = {},
    private readonly now: () => number = Date.now
  ) {}

  /** True when the policy does nothing, so the runtime can skip the wrapper entirely and keep its original call shape. */
  get isNoop(): boolean {
    return !this.policy.callTimeoutMs && !this.policy.retry && !this.policy.circuitBreaker;
  }

  private breakerFor(dataSourceId: string, policy: CircuitBreakerPolicy): CircuitBreaker {
    let breaker = this.breakers.get(dataSourceId);
    if (!breaker) {
      breaker = new CircuitBreaker(policy, this.now);
      this.breakers.set(dataSourceId, breaker);
    }
    return breaker;
  }

  private async callWithTimeout<T>(
    dataSourceId: string,
    timeoutMs: number,
    fn: (signal?: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Reject with the timeout error FIRST so the race adopts it, THEN abort the signal: a
        // cooperative adapter's own abort-rejection must not win the race and mask the deadline.
        reject(new AdapterTimeoutError(`Adapter call to data source "${dataSourceId}" exceeded ${timeoutMs}ms`));
        controller.abort();
      }, timeoutMs);
    });
    try {
      // The race guarantees request-level liveness even for an adapter that ignores the signal;
      // a cooperative adapter that honors it also stops the abandoned work (see AdapterCallOptions).
      return await Promise.race([fn(controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Runs one logical adapter call under the policy. `retryable` says whether
   * this particular call may be retried — idempotent reads always may; an
   * Action only if it declared itself idempotent, which the runtime decides
   * and passes in. `fn` receives the deadline's `AbortSignal` (or `undefined`
   * when no `callTimeoutMs` is set) to forward to a cooperative adapter.
   */
  async run<T>(dataSourceId: string, retryable: boolean, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    const { retry, circuitBreaker, callTimeoutMs } = this.policy;
    const breaker = circuitBreaker ? this.breakerFor(dataSourceId, circuitBreaker) : undefined;
    const maxAttempts = retryable && retry ? Math.max(1, retry.maxAttempts) : 1;

    let attempt = 0;
    for (;;) {
      attempt++;
      if (breaker && !breaker.canAttempt()) {
        throw new CircuitOpenError(`Circuit for data source "${dataSourceId}" is open`);
      }
      try {
        const result = callTimeoutMs
          ? await this.callWithTimeout(dataSourceId, callTimeoutMs, fn)
          : await fn(undefined);
        breaker?.recordSuccess();
        return result;
      } catch (err) {
        breaker?.recordFailure();
        if (attempt >= maxAttempts || !isRetryableError(err)) throw err;
        if (retry) await sleep(backoffDelayMs(attempt, retry));
      }
    }
  }
}
