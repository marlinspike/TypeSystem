import type { QueryFilter } from "../model/query.js";
import type { Adapter, AdapterQueryResult } from "./adapter.js";
import { matchesFilter } from "./filter.js";

/** A scalar an equality condition can be batched on: anything else is passed through unbatched. */
type Key = string | number | boolean;

interface Pending {
  readonly value: Key;
  readonly resolve: (r: AdapterQueryResult) => void;
  readonly reject: (err: unknown) => void;
}

interface Batch {
  readonly adapter: Adapter;
  readonly typeName: string;
  readonly property: string;
  readonly waiting: Pending[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const isKey = (v: unknown): v is Key => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean";

/**
 * Whether `adapter` evaluates equality and membership on `property` in its
 * store exactly as `matchesFilter` does, by the rule authorization pushdown
 * uses (ADR-0040): it says so through `canFilter`, or, saying nothing, the
 * property is not one it protects at rest. Only then is an `in` query split
 * back into per-value answers identical to the `eq` queries it replaces.
 */
async function canBatch(adapter: Adapter, typeName: string, property: string): Promise<boolean> {
  try {
    if (typeof adapter.canFilter === "function") {
      return (await adapter.canFilter(typeName, property, "eq")) === true && (await adapter.canFilter(typeName, property, "in")) === true;
    }
    if (typeof adapter.sensitiveFields === "function") {
      const sensitive = await adapter.sensitiveFields(typeName);
      return Array.isArray(sensitive) && !sensitive.includes(property);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The adapter reads computed properties make during one runtime request,
 * coalesced (ADR-0062). Every computed value on a page runs the same code
 * against different objects, so it repeats the same reads (every work order)
 * and the same lookup by a different key (the events of this aircraft):
 *
 * - an identical read is made once per request and its answer shared;
 * - concurrent `queryByType(type, { property, operator: "eq", value })`
 *   calls with no limit, cursor or sort become one `in` query, split back
 *   per value with `matchesFilter`, when the adapter filters that property
 *   exactly (`canBatch`). If the combined answer comes back paged, each
 *   caller's own query runs instead.
 *
 * It changes how many calls reach an adapter, never what a computation
 * receives: each gets the items its own query would have returned, in the
 * adapter's order, frozen, since other computations share them (a
 * computation that writes to what it read gets a `TypeError`). It lives for one request, so nothing is shared between
 * callers or across time, and computed values are still decided, withheld
 * and audited per object exactly as before.
 */
export class ReadCoalescer {
  private readonly memo = new Map<string, Promise<unknown>>();
  private readonly batches = new Map<string, Batch>();
  private readonly views = new Map<string, Adapter>();
  private scheduled = false;

  /** `adapter` as computed properties see it: the same object, its reads coalesced. */
  view(adapter: Adapter): Adapter {
    const existing = this.views.get(adapter.dataSourceId);
    if (existing) return existing;
    const view: Adapter = new Proxy(adapter, {
      get: (target, prop, receiver) => {
        if (prop === "queryByType") return (...args: Parameters<Adapter["queryByType"]>) => this.query(target, ...args);
        if (prop === "resolveProperties")
          return (...args: Parameters<Adapter["resolveProperties"]>) =>
            args.length > 3 ? target.resolveProperties(...args) : this.once(target, ["resolveProperties", ...args], () => target.resolveProperties(...args));
        return Reflect.get(target, prop, receiver) as unknown;
      }
    });
    this.views.set(adapter.dataSourceId, view);
    return view;
  }

  /**
   * One read per request. Its answer is copied once, so the adapter's own records are never shared or frozen, and
   * frozen, so no computation can change what another receives. (A copy per caller would cost several times the
   * reads it saves.)
   */
  private async once<T>(adapter: Adapter, call: readonly unknown[], run: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([adapter.dataSourceId, ...call]);
    let shared = this.memo.get(key) as Promise<T> | undefined;
    if (!shared) {
      shared = run().then((answer) => deepFreeze(structuredClone(answer)));
      this.memo.set(key, shared);
      // A failed read is not remembered: a later computation in the request asks again, as it would have.
      shared.catch(() => this.memo.delete(key));
    }
    return await shared;
  }

  private query(adapter: Adapter, typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: Parameters<Adapter["queryByType"]>[4], ...rest: unknown[]): Promise<AdapterQueryResult> {
    // Anything carrying its own call options, or paging, sorting or limiting, is the caller's own query.
    if (rest.length > 0 || limit !== undefined || cursor !== undefined || (sort !== undefined && sort.length > 0)) {
      return adapter.queryByType(typeName, filter, limit, cursor, sort);
    }
    if (filter && "property" in filter && filter.operator === "eq" && isKey(filter.value)) {
      const { property, value } = filter;
      return this.once(adapter, ["queryByType", typeName, filter], () => this.batched(adapter, typeName, property, value));
    }
    return this.once(adapter, ["queryByType", typeName, filter ?? null], () => adapter.queryByType(typeName, filter));
  }

  private batched(adapter: Adapter, typeName: string, property: string, value: Key): Promise<AdapterQueryResult> {
    const key = JSON.stringify([adapter.dataSourceId, typeName, property]);
    let batch = this.batches.get(key);
    if (!batch) {
      batch = { adapter, typeName, property, waiting: [] };
      this.batches.set(key, batch);
    }
    const promise = new Promise<AdapterQueryResult>((resolve, reject) => batch.waiting.push({ value, resolve, reject }));
    if (!this.scheduled) {
      this.scheduled = true;
      // After the current turn's I/O callbacks, so every computation started in this burst has asked.
      setImmediate(() => void this.flush());
    }
    return promise;
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const batches = [...this.batches.values()];
    this.batches.clear();
    await Promise.all(batches.map((b) => this.run(b)));
  }

  private async run({ adapter, typeName, property, waiting }: Batch): Promise<void> {
    const alone = (p: Pending) => adapter.queryByType(typeName, { property, operator: "eq", value: p.value }).then(p.resolve, p.reject);
    try {
      if (waiting.length === 1 || !(await canBatch(adapter, typeName, property))) {
        await Promise.all(waiting.map(alone));
        return;
      }
      const values = [...new Set(waiting.map((p) => p.value))];
      // A combined read that fails or comes back paged is no answer for anyone: each caller's own query runs instead.
      const combined = await adapter.queryByType(typeName, { property, operator: "in", value: values }).catch(() => undefined);
      const all = combined && deepFreeze(structuredClone(combined));
      if (all === undefined || all.nextCursor !== undefined) {
        await Promise.all(waiting.map(alone));
        return;
      }
      for (const p of waiting) {
        const condition: QueryFilter = { property, operator: "eq", value: p.value };
        p.resolve(deepFreeze({ items: all.items.filter((item) => matchesFilter(item.values, condition)) }));
      }
    } catch (err) {
      for (const p of waiting) p.reject(err);
    }
  }
}
