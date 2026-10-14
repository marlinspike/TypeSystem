import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CodeMeasure } from "./types.js";

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(["node_modules", "dist", ".git", ".work"]);

/** Source files the producer wrote under `dir`. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (SKIP.has(f)) return [];
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return SOURCE.test(f) && !f.endsWith(".d.ts") ? [p] : [];
  });
}

/** Lines that are neither blank nor only a comment. */
export function codeLines(text: string): string[] {
  let inBlock = false;
  return text.split("\n").filter((raw) => {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      return false;
    }
    if (line.startsWith("/*")) {
      inBlock = !line.includes("*/");
      return false;
    }
    return line !== "" && !line.startsWith("//") && !line.startsWith("*");
  });
}

/**
 * Measures the code in an application directory. Each number is a count
 * over the source text, chosen so it can be recomputed by anyone; none is a
 * judgment of quality on its own.
 */
export function measureCode(dir: string): CodeMeasure {
  const files = sourceFiles(dir);
  const imports = new Set<string>();
  let lines = 0;
  let largest = 0;
  let branches = 0;
  let direct = 0;
  let rules = 0;
  for (const file of files) {
    const code = codeLines(readFileSync(file, "utf8"));
    lines += code.length;
    largest = Math.max(largest, code.length);
    const text = code.join("\n");
    for (const m of text.matchAll(/(?:from\s+|import\(\s*|require\(\s*)["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".") || spec.startsWith("/")) {
        // A relative or absolute path that leaves the application reaches code no arm lists (P3-V3).
        const rel = path.relative(dir, path.resolve(path.dirname(file), spec)).split(path.sep).join("/");
        if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) imports.add(`${/(?:^|\/)(packages\/[^/]+)/.exec(rel)?.[1] ?? rel} (by path)`);
        continue;
      }
      imports.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
    }
    branches += (text.match(/\bif\s*\(|\?(?![.?])|&&|\|\||\bcase\b|\bcatch\b/g) ?? []).length;
    direct += (text.match(/\bfetch\s*\(|\bhttp\.request\s*\(|\baxios\b/g) ?? []).length;
    rules += (text.match(/(?:===|!==|includes\()\s*["'](?:maintainer|lead|viewer|planner|demo-[a-z-]+-token)["']/g) ?? []).length;
  }
  return {
    files: files.length,
    codeLines: lines,
    imports: [...imports].sort(),
    directServiceCalls: direct,
    restatedAccessRules: rules,
    branchDensity: lines === 0 ? 0 : Math.round((branches / lines) * 1000) / 10,
    largestFileLines: largest
  };
}

/** The p-th percentile (0–100) of `values`, by nearest rank. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}
