/**
 * The product is TypeSystem, or TypeSys for short (ADR-0064). This check
 * keeps the retired short name out of every tracked text file: docs, ADRs,
 * source, comments, CLI help, UI strings, package metadata and the
 * instructions written for coding agents.
 *
 * A match is the retired name not followed by a lowercase letter, so
 * `TypeScript`, `TypeSys` and `TypeSystem` pass, and so do `Types` and the
 * `typesys` identifiers. A line that must quote the retired name (this
 * file's tests, a migration note) carries the marker `terminology-allow:`
 * followed by its reason, and is skipped; a bare marker is not enough
 * (ADR-0064). A file's path is checked as well as its text, and a text
 * file is read whatever its encoding.
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
/** The marker, a colon, and a reason of at least two words. */
const ALLOWED = new RegExp(`${ALLOW_MARKER}:\\s*\\w+\\W+\\w+`);

/** Files never checked: generated lockfiles, and binary or archive formats. */
const SKIPPED = [/(^|\/)package-lock\.json$/, /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|zip|gz|tgz|wasm)$/i];

export function isChecked(file: string): boolean {
  return !SKIPPED.some((p) => p.test(file));
}

export function findViolations(file: string, text: string): TerminologyViolation[] {
  const found: TerminologyViolation[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (ALLOWED.test(line)) return;
    for (const m of line.matchAll(PATTERN)) found.push({ file, line: i + 1, column: (m.index ?? 0) + 1, text: line.trim().slice(0, 160) });
  });
  return found;
}

/** The retired name in a file's path (P3-T2). */
export function pathViolations(file: string): TerminologyViolation[] {
  return [...file.matchAll(PATTERN)].map((m) => ({ file, line: 0, column: (m.index ?? 0) + 1, text: `path: ${file}` }));
}

/**
 * A file's text, whatever its encoding (P3-T1): UTF-16 with a byte order
 * mark is decoded as such, and NUL bytes (UTF-16 without a mark, or one
 * stray NUL in a text file) are dropped rather than hiding the file.
 */
export function decodeText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2)));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8").replaceAll("\u0000", "");
}

/** The suggested replacement for a violating line, for the report: TypeSys where a short name was meant. */
export function suggest(line: string): string {
  return line.replace(PATTERN, "TypeSys");
}
