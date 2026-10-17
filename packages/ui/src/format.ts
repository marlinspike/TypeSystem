/** How a value is shown (the IR's `format`). */
export type ValueFormat = "text" | "number" | "integer" | "percent" | "currency" | "date" | "date-time" | "relative-time" | "duration-minutes" | "badge" | "boolean" | "temperature";
export type Tone = "neutral" | "info" | "good" | "warn" | "bad";

export const TONES: readonly Tone[] = ["neutral", "info", "good", "warn", "bad"];
export const isTone = (v: unknown): v is Tone => typeof v === "string" && (TONES as readonly string[]).includes(v);

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** `2026-10-16T08:00:00Z` → "3 hours ago", against `now`. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = (t - now) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return relative.format(Math.round(s), "second");
  if (abs < 3600) return relative.format(Math.round(s / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(s / 3600), "hour");
  return relative.format(Math.round(s / 86400), "day");
}

/**
 * A known value as text. Unknown (`undefined`) is not formatted here: the
 * component shows it as withheld or pending, which only it can tell apart.
 */
export function formatValue(v: unknown, format: ValueFormat | undefined): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    switch (format) {
      case "integer":
        return integer.format(v);
      case "percent":
        return percent.format(v);
      case "currency":
        // Whole amounts as whole dollars; a price with cents keeps them, never rounded to a different price.
        return (Number.isInteger(v) ? currency : cents).format(v);
      case "temperature":
        return `${number.format(v)} °C`;
      case "duration-minutes":
        return v >= 60 ? `${Math.floor(v / 60)} h ${Math.round(v % 60)} min` : `${Math.round(v)} min`;
      default:
        return number.format(v);
    }
  }
  if (typeof v === "string") {
    if (format === "date" || format === "date-time" || format === "relative-time") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return format === "date" ? date.format(t) : format === "date-time" ? dateTime.format(t) : relativeTime(v);
    }
    return format === "badge" ? humanize(v) : v;
  }
  if (Array.isArray(v)) return v.map((x) => formatValue(x, format)).join(", ");
  return JSON.stringify(v);
}

/** `in_transit` / `inTransit` → "In transit". */
export function humanize(s: string): string {
  // An acronym or code (`PMC`, `NMC`, `2-8C`) is shown as it is.
  if (/^[A-Z0-9][A-Z0-9_.-]*$/.test(s) && /[A-Z]/.test(s)) return s.replace(/_/g, " ");
  const words = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A field name as a label: `excursionMinutes` → "Excursion minutes". */
export const labelOf = humanize;

/** A value as text, or undefined while it is unknown: never the string "undefined". */
export function toText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

/** A number, or undefined for anything else. */
export const toNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A row's stable key: its object id when it has one, else its position. */
export const keyOf = (row: unknown, i: number): string => {
  const id = row && typeof row === "object" ? (row as { $id?: unknown }).$id : undefined;
  return typeof id === "string" ? id : String(i);
};

/**
 * What an interaction's `$result` is: an Action's output or a run, whose
 * shape the model does not fix. Reading a field of it is unchecked, so a
 * generated page passes it only to effects, which take any value.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ResultValue = Readonly<Record<string, any>> | undefined;
