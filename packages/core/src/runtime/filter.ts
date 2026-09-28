import type { QueryFilter, QueryCondition } from "../model/query.js";

function matchesCondition(values: Record<string, unknown>, condition: QueryCondition): boolean {
  const actual = values[condition.property];
  switch (condition.operator) {
    case "eq":
      return actual === condition.value;
    case "ne":
      return actual !== condition.value;
    case "gt":
      return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
    case "gte":
      return typeof actual === "number" && typeof condition.value === "number" && actual >= condition.value;
    case "lt":
      return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
    case "lte":
      return typeof actual === "number" && typeof condition.value === "number" && actual <= condition.value;
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case "contains":
      return Array.isArray(actual) && actual.includes(condition.value);
    default:
      return false;
  }
}

/** Every property name a filter tree references, walked iteratively (validated filters are depth-bounded anyway). */
export function filterProperties(filter: QueryFilter): Set<string> {
  const names = new Set<string>();
  const stack: QueryFilter[] = [filter];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ("and" in node) stack.push(...node.and);
    else if ("or" in node) stack.push(...node.or);
    else names.add(node.property);
  }
  return names;
}

/**
 * Shared interpreter for the structured query DSL (see ADR-0011). Any
 * adapter that supports `queryByType` filtering can reuse this rather than
 * re-implementing filter semantics per adapter.
 */
export function matchesFilter(values: Record<string, unknown>, filter?: QueryFilter): boolean {
  if (!filter) return true;
  if ("and" in filter) return filter.and.every((f) => matchesFilter(values, f));
  if ("or" in filter) return filter.or.some((f) => matchesFilter(values, f));
  return matchesCondition(values, filter);
}
