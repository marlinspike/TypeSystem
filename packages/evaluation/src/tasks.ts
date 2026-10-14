import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "./types.js";

/** The evaluation's own directory: tasks, hidden checks, references and results. */
export const EVALUATION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TASKS_DIR = path.join(EVALUATION_DIR, "tasks");
export const HIDDEN_DIR = path.join(EVALUATION_DIR, "hidden");

export const contractText = (): string => readFileSync(path.join(TASKS_DIR, "CONTRACT.md"), "utf8");

export function loadTask(id: string): Task {
  const dir = path.join(TASKS_DIR, id);
  const meta = JSON.parse(readFileSync(path.join(dir, "task.json"), "utf8")) as Omit<Task, "id" | "requirement">;
  return { id, ...meta, requirement: readFileSync(path.join(dir, "requirement.md"), "utf8") };
}

export const taskIds = (): string[] =>
  readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

export const hiddenFile = (id: string): string => path.join(HIDDEN_DIR, `${id}.mjs`);
