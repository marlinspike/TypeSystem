/**
 * The product is TypeSystem, or TypeSys for short (ADR-0064). This check
 * keeps the retired short name out of every tracked text file: docs, ADRs,
 * source, comments, CLI help, UI strings, package metadata and the
 * instructions written for coding agents.
 *
 * A match is the retired name not followed by a lowercase letter, so
 * `TypeScript`, `TypeSys` and `TypeSystem` pass, and so do `Types` and the
 * `typesys` identifiers. A line that must quote the retired name (this
 * file's tests, a migration note) carries the marker `terminology-allow`
 * with a reason, and is skipped.
 */
export interface TerminologyViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

/** Built from parts so this file does not match itself. */
const RETIRED = ["Type", "S"].join("");
const PATTERN = new RegExp(`${RETIRED}(?![a-z])`, "g");
export const ALLOW_MARKER = "terminology-allow";

/** Files never checked: generated lockfiles, and binary or archive formats. */
const SKIPPED = [/(^|\/)package-lock\.json$/, /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|zip|gz|tgz|wasm)$/i];

export function isChecked(file: string): boolean {
  return !SKIPPED.some((p) => p.test(file));
}

export function findViolations(file: string, text: string): TerminologyViolation[] {
  const found: TerminologyViolation[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const m of line.matchAll(PATTERN)) found.push({ file, line: i + 1, column: (m.index ?? 0) + 1, text: line.trim().slice(0, 160) });
  });
  return found;
}

/** The suggested replacement for a violating line, for the report: TypeSys where a short name was meant. */
export function suggest(line: string): string {
  return line.replace(PATTERN, "TypeSys");
}
