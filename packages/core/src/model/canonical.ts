/**
 * JSON with object keys sorted, so two equal values serialize identically
 * whatever order their keys were written in: what a replay check compares
 * (ADR-0057) and what a pack's digest is computed over (ADR-0059).
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v
  );
}
