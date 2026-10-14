import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent } from "./agent.js";
import { ARMS } from "./arms.js";
import { renderReport } from "./report.js";
import { contamination, createSandbox } from "./sandbox.js";
import { loadHidden, scoreApp } from "./score.js";
import { contractText, EVALUATION_DIR, hiddenFile, loadTask, taskIds } from "./tasks.js";
import type { ArmId, ProductionLog, RunScore } from "./types.js";

export const EVALUATE_USAGE = `npm run evaluate -- <command>

  score   --task <id> --arm <arm> --dir <app> --producer <who> --source person|reference|agent
          Score an application someone produced against the task's hidden checks.
  sandbox --task <id> --arm <arm> [--out <dir>]
          Build the isolated copy an arm works in, and list any prior art it holds.
  agent   --task <id> --arm agent-with|agent-without --model <id> --budget <usd> --allow-spend
          Run an agent in a fresh sandbox, then score what it built. Spends money.
  report  Write results/REPORT.md from every result in results/.

Tasks: ${taskIds().join(", ")}. Arms: conventional, agent-without, agent-with.`;

export const RESULTS_DIR = path.join(EVALUATION_DIR, "results");

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function save(score: RunScore): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${score.task}--${score.arm}--${score.at.replaceAll(":", "-")}.json`);
  writeFileSync(file, `${JSON.stringify(score, null, 2)}\n`);
  return file;
}

/** Runs `npm run evaluate -- <argv>`; returns the exit code. */
export async function evaluateCommand(argv: readonly string[], out: (s: string) => void = console.log): Promise<number> {
  const [command] = argv;
  const taskId = flag(argv, "task");
  const armId = flag(argv, "arm") as ArmId | undefined;
  if (command === "report") {
    // No results yet is a report of tasks not run, not a crash (P3-V6).
    mkdirSync(RESULTS_DIR, { recursive: true });
    const scores = readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(RESULTS_DIR, f), "utf8")) as RunScore);
    writeFileSync(path.join(RESULTS_DIR, "REPORT.md"), renderReport(scores, { tasks: taskIds() }));
    out(`wrote ${path.join(RESULTS_DIR, "REPORT.md")} from ${scores.length} runs`);
    return 0;
  }
  if (!taskId || !taskIds().includes(taskId) || !armId || !(armId in ARMS)) {
    out(EVALUATE_USAGE);
    return 1;
  }
  const task = loadTask(taskId);
  const arm = ARMS[armId];
  const hidden = await loadHidden(hiddenFile(taskId));

  if (command === "score") {
    const dir = flag(argv, "dir");
    const source = flag(argv, "source") as ProductionLog["source"] | undefined;
    if (!dir || !source) {
      out(EVALUATE_USAGE);
      return 1;
    }
    const score = await scoreApp({ task: taskId, arm: armId, dir: path.resolve(dir), hidden, production: { source, producer: flag(argv, "producer") ?? source, humanInterventions: Number(flag(argv, "interventions") ?? 0) } });
    out(`${score.passed}/${score.total} hidden checks; saved ${save(score)}`);
    return 0;
  }
  if (command === "sandbox" || command === "agent") {
    const dir = flag(argv, "out") ?? path.join(tmpdir(), `typesys-eval-${taskId}-${armId}-${Date.now()}`);
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      out(`${dir} already holds files: give --out an empty or new directory, so the sandbox holds nothing but what the arm is given`);
      return 1;
    }
    const repo = path.resolve(EVALUATION_DIR, "../..");
    createSandbox(repo, dir, task, arm, contractText());
    const prior = contamination(dir, task);
    out(`sandbox ${dir}; prior art naming this task: ${prior.length === 0 ? "none" : prior.join(", ")}`);
    if (command === "sandbox") return 0;
    const model = flag(argv, "model");
    const budget = Number(flag(argv, "budget"));
    if (arm.producer !== "agent" || !model || !(budget > 0)) {
      out(EVALUATE_USAGE);
      return 1;
    }
    const production = await runAgent({ sandbox: dir, arm, model, maxBudgetUsd: budget, allowSpend: argv.includes("--allow-spend") });
    const score = await scoreApp({ task: taskId, arm: armId, dir: path.join(dir, "app"), hidden, production: { ...production, notes: [production.notes, prior.length ? `prior art: ${prior.join(", ")}` : ""].filter(Boolean).join("; ") } });
    out(`${score.passed}/${score.total} hidden checks; saved ${save(score)}`);
    return 0;
  }
  out(EVALUATE_USAGE);
  return 1;
}
