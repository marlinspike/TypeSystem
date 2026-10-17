/**
 * What a compiled flow's generated workflow calls (ADR-0081). Each helper
 * keeps one of the engine's rules where a step's own code would otherwise
 * have to: a value the step needs is known, a read finishes in time, a
 * list is no longer than the flow said, and a read the flow may do without
 * fails only for a reason worth carrying on from.
 */

/** A step's failure that another attempt may cure: the engine retries it under the step's `retry` (ADR-0057). */
export class RetryableStepError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "RetryableStepError";
  }
}

/** A value the step cannot do without is unknown: withheld from the initiator, or from a skipped step. Not retried. */
export class UnknownValueError extends Error {
  constructor(readonly what: string) {
    super(`${what} is unknown: the run's initiator may not read it, or the step that gives it was skipped`);
    this.name = "UnknownValueError";
  }
}

/** The value, or a failure of the step that names what was unknown. */
export function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new UnknownValueError(what);
  return value;
}

/**
 * A read that must finish within `ms`: a later answer fails the step
 * retryably. The read itself is not cancelled (the SDK does not take a
 * signal); its answer, when it comes, is ignored.
 */
export async function within<T>(ms: number, what: string, read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RetryableStepError(`${what} did not answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether an error is a source failing to answer (ADR-0072), as opposed to a refusal or a mistake. */
export function isSourceFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { retryable?: unknown; name?: unknown };
  // By name, so a runtime reached through another copy of @typesys/core is recognized too.
  return e.retryable === true || e.name === "AdapterTimeoutError" || e.name === "AdapterUnavailableError" || e.name === "CircuitOpenError";
}

/**
 * A read the flow carries on without (`onError: "continue"`): a source that
 * fails to answer leaves the output unknown. A refusal, a bad request or a
 * bug still fails the step, because carrying on from those would hide them.
 */
export async function orUnknown<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    if (isSourceFailure(err)) return undefined;
    throw err;
  }
}

/**
 * One read per element, at most `max` elements and `concurrency` at once,
 * in the list's order. A longer list fails the step: cutting it short would
 * be an answer about part of the list presented as the whole.
 */
export async function forEachBounded<T, R>(list: readonly T[] | undefined | null, max: number, concurrency: number, read: (item: T) => Promise<R>, what: string): Promise<R[]> {
  const items = need(list, what);
  if (items.length > max) throw new Error(`${what} has ${items.length} elements, more than the ${max} this step may read`);
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await read(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}

/** The outputs of a `parallel` step's reads, each by its own name, run at once. */
export async function parallel<R extends Record<string, () => Promise<unknown>>>(reads: R): Promise<{ [K in keyof R]: Awaited<ReturnType<R[K]>> }> {
  const names = Object.keys(reads) as (keyof R)[];
  const values = await Promise.all(names.map((n) => reads[n]!()));
  return Object.fromEntries(names.map((n, i) => [n, values[i]])) as { [K in keyof R]: Awaited<ReturnType<R[K]>> };
}

/** Fails a `check` step unless its condition holds; an unknown condition does not. */
export function assertHolds(condition: boolean | undefined, message: string): true {
  if (condition !== true) throw new Error(condition === undefined ? `${message} (the run's initiator may not read what this check depends on)` : message);
  return true;
}
