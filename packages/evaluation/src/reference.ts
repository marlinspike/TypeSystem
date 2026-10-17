import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadHost, scaffoldMission, type MissionSpec } from "@typesys/engineer";
import { EVALUATION_DIR } from "./tasks.js";

export const REFERENCES_DIR = path.join(EVALUATION_DIR, "references");

/**
 * A reference application for a task: its mission spec, scaffolded by the
 * engineering loop with no hand edits, and a `package.json` for the
 * contract. It exists to show the hidden checks and the harness can be
 * passed; it is not an arm's result, since it was written by the people who
 * wrote the tasks.
 */
export async function buildReference(taskId: string, dir: string): Promise<string> {
  const app = referenceApp(taskId);
  if (app) return app;
  const spec = JSON.parse(readFileSync(path.join(REFERENCES_DIR, `${taskId}.json`), "utf8")) as MissionSpec;
  rmSync(dir, { recursive: true, force: true });
  const { host } = await loadHost(spec, EVALUATION_DIR);
  await scaffoldMission(spec, host, dir);
  (host as { services?: { stop(): Promise<void> } }).services?.stop().catch(() => undefined);
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: `reference-${taskId}`, private: true, type: "module", scripts: { build: "tsc -p .", start: "node dist/server.js" } }, null, 2)}\n`);
  return dir;
}

/**
 * A task whose reference is a 4.0 application in the repository rather than
 * a mission (`{ "app": "<dir from the repository root>" }`): the recall
 * response, which the showcase's engineer built after the task was written.
 * Scoring builds it with its own `build` script.
 */
export function referenceApp(taskId: string): string | undefined {
  const file = path.join(REFERENCES_DIR, `${taskId}.json`);
  if (!existsSync(file)) return undefined;
  const ref = JSON.parse(readFileSync(file, "utf8")) as { app?: unknown };
  return typeof ref.app === "string" ? path.resolve(EVALUATION_DIR, "../..", ref.app) : undefined;
}
