import type { SortKey } from "../model/query.js";

/**
 * A total order for sort keys (see ADR-0027): numbers numerically, booleans
 * `false` before `true`, everything else by its string form, and
 * null/undefined last. Deterministic, so every adapter that reuses it sorts
 * a page identically — the same "one shared interpreter, not re-implemented
 * per adapter" property `matchesFilter` gives filtering (ADR-0011).
 */
export function compareForSort(a: unknown, b: unknown): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  const as = sortableString(a);
  const bs = sortableString(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** A stable string key for a sort value of any type — never the `[object Object]` a bare `String()` on an object would give. */
function sortableString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * Applies a multi-key sort, reusing `compareForSort` across every adapter.
 * Returns a new array and is stable within equal keys (ties keep input
 * order). `valuesOf` adapts each item to its property bag, so the same
 * function serves the in-memory, mock-REST, and Postgres row shapes.
 */
export function applySort<T>(
  items: readonly T[],
  sort: SortKey[] | undefined,
  valuesOf: (item: T) => Record<string, unknown>
): T[] {
  if (!sort || sort.length === 0) return [...items];
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => {
      for (const key of sort) {
        const cmp = compareForSort(valuesOf(x.item)[key.property], valuesOf(y.item)[key.property]);
        if (cmp !== 0) return key.direction === "desc" ? -cmp : cmp;
      }
      return x.index - y.index;
    })
    .map((w) => w.item);
}

/**
 * Trims a value bag to the projected property set (ADR-0027). Applied by the
 * runtime *after* redaction, so a property the caller can't read is already
 * absent and simply won't appear; a selected property the object doesn't have
 * is skipped rather than returned as `undefined`. Returns the bag unchanged
 * when no projection is requested.
 */
export function applyProjection(
  values: Record<string, unknown>,
  select: string[] | undefined
): Record<string, unknown> {
  if (!select) return values;
  const out: Record<string, unknown> = {};
  for (const name of select) if (name in values) out[name] = values[name];
  return out;
}
