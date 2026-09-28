/**
 * Bounded-concurrency map — replaces an unbounded `Promise.all`/
 * `Promise.allSettled` fan-out (e.g. resolving a relationship with
 * thousands of related objects, or a query page with a large `limit`)
 * with a fixed number of concurrent workers, so one call can't open
 * thousands of simultaneous adapter calls/DB connections at once (see
 * ADR-0019). Preserves input order in the output array regardless of
 * completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: boundedLimit }, () => worker()));
  return results;
}

/** Like `mapWithConcurrency`, but never rejects — mirrors `Promise.allSettled`. */
export async function mapWithConcurrencySettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(items, limit, async (item, index): Promise<PromiseSettledResult<R>> => {
    try {
      return { status: "fulfilled", value: await fn(item, index) };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  });
}

/**
 * A counting semaphore: at most `permits` calls to `run` execute at once;
 * the rest wait in FIFO order. A released permit passes straight to the
 * next waiter, so a steady stream of new callers can't starve old ones.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    }
  }
}
