/**
 * `npm run check:terminology`: fails when any tracked text file uses the
 * retired product name (ADR-0064). Run in CI beside lint.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findViolations, isChecked, suggest } from "../tools/terminology/terminology.js";

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean).filter(isChecked);
const violations = files.flatMap((file) => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return []; // Deleted in the working tree but still in the index.
  }
  return text.includes("\u0000") ? [] : findViolations(file, text);
});

if (violations.length === 0) {
  console.log(`terminology: ${files.length} files checked, the product is TypeSystem or TypeSys throughout`);
} else {
  for (const v of violations) console.error(`${v.file}:${v.line}:${v.column}  ${v.text}\n    suggest: ${suggest(v.text)}`);
  console.error(`\nterminology: ${violations.length} use(s) of the retired product name. Write TypeSystem, or TypeSys for short (docs/adr/0064-the-product-is-typesystem.md).`);
  process.exit(1);
}
