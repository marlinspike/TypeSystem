import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Arm } from "./arms.js";
import type { ProductionLog } from "./types.js";

export interface AgentRunOptions {
  /** The sandbox (see `createSandbox`); the agent works there and builds in `app/`. */
  readonly sandbox: string;
  readonly arm: Arm;
  readonly model: string;
  /** Hard ceiling for this run, enforced by Claude Code (`--max-budget-usd`). */
  readonly maxBudgetUsd: number;
  /** Must be true: an agent run spends money, and only the owner approves that (ADR-0073). */
  readonly allowSpend: boolean;
}

/** What `claude -p --output-format json` reports at the end of a run. */
interface ClaudeResult {
  readonly duration_ms?: number;
  readonly num_turns?: number;
  readonly total_cost_usd?: number;
  readonly is_error?: boolean;
  readonly usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/** The command an agent run executes; exported so a run can be inspected, or repeated by hand, without spending. */
export function agentCommand(o: Omit<AgentRunOptions, "allowSpend">): { command: string; args: string[] } {
  const args = [
    "-p",
    "Read BRIEF.md, REQUIREMENT.md and CONTRACT.md in this directory, then do what BRIEF.md says.",
    "--output-format",
    "json",
    "--model",
    o.model,
    "--max-budget-usd",
    String(o.maxBudgetUsd),
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    path.join(o.sandbox, ".eval-mcp.json")
  ];
  return { command: "claude", args };
}

/**
 * Runs one agent on one sandbox, headless, and returns what it cost. The
 * engineering loop's MCP server is configured only for the arm offered it;
 * no other MCP server is reachable (`--strict-mcp-config`).
 */
export async function runAgent(o: AgentRunOptions): Promise<ProductionLog> {
  if (!o.allowSpend) throw new Error("an agent run spends money; pass allowSpend only with the owner's approval of the expected cost");
  const servers = o.arm.engineerTools ? { "typesys-engineer": { command: process.execPath, args: [path.join(o.sandbox, "packages/engineer/dist/mcp-bin.js"), o.sandbox] } } : {};
  writeFileSync(path.join(o.sandbox, ".eval-mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
  const { command, args } = agentCommand(o);
  const started = Date.now();
  const child = spawn(command, args, { cwd: o.sandbox, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString()));
  child.stderr.on("data", (c: Buffer) => (err += c.toString()));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  writeFileSync(path.join(o.sandbox, ".eval-agent.json"), out);
  let result: ClaudeResult = {};
  try {
    result = JSON.parse(out) as ClaudeResult;
  } catch {
    // Recorded below as a note; the run is still scored on what it left in app/.
  }
  const u = result.usage;
  return {
    source: "agent",
    producer: o.model,
    wallMs: result.duration_ms ?? Date.now() - started,
    ...(u ? { tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } } : {}),
    ...(result.total_cost_usd !== undefined ? { costUsd: result.total_cost_usd } : {}),
    humanInterventions: 0,
    notes: [`exit ${code ?? "signal"}`, result.num_turns !== undefined ? `${result.num_turns} turns` : "", result.is_error ? "the agent reported an error" : "", err.trim().slice(-300)].filter(Boolean).join("; ")
  };
}
