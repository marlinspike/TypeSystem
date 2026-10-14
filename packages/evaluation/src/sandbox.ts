import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { armBrief, type Arm } from "./arms.js";
import { sourceFiles } from "./measure.js";
import type { Task } from "./types.js";

/**
 * Paths an arm never sees: the evaluation itself (hidden checks among it),
 * every existing mission application and its spec, the tests and review
 * reports that quote them, and the repository's history.
 */
const WITHHELD = [/^\.git$/, /^packages\/evaluation$/, /^examples\/missions$/, /^packages\/mission-readiness$/, /^packages\/[^/]+\/test$/, /^packages\/[^/]+\/\.work$/, /^docs\/evidence$/, /^docs\/reviews$/, /^node_modules$/, /(^|\/)\.work$/];

/**
 * Builds an isolated copy of the repository for one run: the packages as
 * built, without what `WITHHELD` names, with the task's requirement and the
 * contract at its root and an empty `app/` to build in. The engineering
 * loop's skill is present only for the arm that is offered it.
 */
export function createSandbox(repo: string, dir: string, task: Task, arm: Arm, contract: string): string {
  mkdirSync(dir, { recursive: true });
  cpSync(repo, dir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(repo, src).split(path.sep).join("/");
      if (rel === "") return true;
      if (WITHHELD.some((r) => r.test(rel))) return false;
      if (rel === ".claude" || rel.startsWith(".claude/")) return arm.engineerTools && (rel === ".claude" || rel === ".claude/skills" || rel.startsWith(".claude/skills/typesys-engineer"));
      return true;
    }
  });
  // Third-party packages are shared read-only; the workspace's own resolve inside the sandbox.
  const modules = path.join(dir, "node_modules");
  mkdirSync(path.join(modules, "@typesys"), { recursive: true });
  for (const entry of readdirSync(path.join(repo, "node_modules"))) {
    if (entry !== "@typesys") symlinkSync(path.join(repo, "node_modules", entry), path.join(modules, entry));
  }
  for (const pkg of readdirSync(path.join(dir, "packages"))) {
    const manifest = path.join(dir, "packages", pkg, "package.json");
    if (!existsSync(manifest)) continue;
    const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name;
    if (name.startsWith("@typesys/")) symlinkSync(path.join("..", "..", "packages", pkg), path.join(modules, name));
  }
  writeFileSync(path.join(dir, "REQUIREMENT.md"), task.requirement);
  writeFileSync(path.join(dir, "CONTRACT.md"), contract);
  writeFileSync(path.join(dir, "BRIEF.md"), armBrief(arm));
  mkdirSync(path.join(dir, "app"), { recursive: true });
  return dir;
}

/**
 * Files in a sandbox that name the task's solution (its workflow or its
 * approval step), outside the task's own text: prior art the arm could
 * find. Reported with every run, never hidden.
 */
export function contamination(dir: string, task: Task): string[] {
  const own = new Set(["REQUIREMENT.md", "CONTRACT.md", "BRIEF.md"]);
  const files = [...sourceFiles(dir), ...markdownFiles(dir)];
  return files
    .map((f) => path.relative(dir, f))
    .filter((rel) => !own.has(rel) && !rel.startsWith(`app${path.sep}`))
    .filter((rel) => {
      const text = readFileSync(path.join(dir, rel), "utf8");
      return task.markers.some((m) => text.includes(m));
    })
    .sort();
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(p);
    return /\.(md|json)$/.test(e.name) ? [p] : [];
  });
}
