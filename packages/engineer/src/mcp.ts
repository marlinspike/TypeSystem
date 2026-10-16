import path from "node:path";
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { tryLoadHost } from "./host.js";
import { parseMission } from "./mission.js";
import { planMission } from "./plan.js";
import { scaffoldMission } from "./scaffold.js";
import { verifyMission } from "./verify.js";
import { engineerCommand } from "./cli.js";
import { insideRoot } from "@typesys/devkit";

export { insideRoot };

/**
 * The engineering loop as MCP tools (ADR-0071), for an agent that already
 * writes code (Claude Code, or any other MCP client). It is a developer
 * tool, separate from the governed runtime's MCP server: it reads and
 * writes files and runs builds, so every path it is given must be inside
 * `root`, and it never starts anything but the application it verifies.
 */
export const ENGINEER_TOOLS: readonly Tool[] = [
  {
    name: "typesys_engineer_plan",
    description:
      "Plan a mission spec (typesys.mission/1) against its governed model: what the model already provides and who is told of it, which files the application needs, and every problem as a diagnostic {code, severity, at, message, hint}. Run before scaffolding, and after each change to the spec.",
    inputSchema: { type: "object", properties: { mission: { type: "string", description: "Path to mission.json, relative to the server's root" } }, required: ["mission"], additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "typesys_engineer_scaffold",
    description:
      "Plan, then write the application a mission describes into a directory: mission.json, the typed client model, the workflow, views, a server over the governed API, and acceptance tests. Refuses (writing nothing) when the plan has an error. Overwrites the generated files in that directory.",
    inputSchema: {
      type: "object",
      properties: { mission: { type: "string", description: "Path to mission.json, relative to the server's root" }, out: { type: "string", description: "Directory to write, relative to the server's root" } },
      required: ["mission", "out"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  {
    name: "typesys_engineer_verify",
    description:
      "Verify the application in a directory against its mission.json: plan, build (tsc and the views bundle), start it, and run every acceptance check through its API as each caller. Returns {ok, stages, checks, diagnostics}; each failing check names what was observed and a hint. Repair from the diagnostics and verify again until ok.",
    inputSchema: { type: "object", properties: { dir: { type: "string", description: "The application's directory, relative to the server's root" } }, required: ["dir"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "typesys_engineer_draft",
    description:
      "Draft a mission spec from a brief (typesys.mission-brief/1: a requirement in words, the host, the callers, the policy rules), with you as the development model (agent mode, ADR-0077). Call it with the answers you have written so far, in order; while another is needed it returns {answerNeeded: true, request}: read the request, write your answer as JSON to a file, and call again with that file added. When done it writes the spec to `out` with every round's diagnostics. Review the acceptance checks before scaffolding.",
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "Path to the brief, relative to the server's root" },
        out: { type: "string", description: "Where to write mission.json, relative to the server's root" },
        answers: { type: "array", items: { type: "string" }, description: "Your answers so far, as files relative to the root, in order" },
        feedback: { type: "array", items: { type: "string" }, description: "Files with what verify or a reviewer said about a clean draft, one round each" }
      },
      required: ["brief", "out"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }
];

/** The mission at `file`. A file that is not a mission is reported without its contents, which may not be the agent's to read. */
async function readSpec(file: string): Promise<ReturnType<typeof parseMission>> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    const reason = err instanceof SyntaxError ? "it is not JSON" : (err as NodeJS.ErrnoException).code === "ENOENT" ? "it does not exist" : "it cannot be read";
    return { diagnostics: [{ code: "invalid-mission", severity: "error", at: "mission.json", message: `cannot read the mission: ${reason}` }] };
  }
  return parseMission(doc);
}

/** Runs one engineer tool; the result is JSON, an error a `{ ok: false, error }` result rather than a protocol failure. */
export async function callEngineerTool(root: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean } & Record<string, unknown>> {
  try {
    if (name === "typesys_engineer_verify") return { ...(await verifyMission(insideRoot(root, args.dir), { within: root })) };
    if (name === "typesys_engineer_draft") return await draftTool(root, args);
    if (name !== "typesys_engineer_plan" && name !== "typesys_engineer_scaffold") return { ok: false, error: `Unknown tool ${name}` };
    const file = insideRoot(root, args.mission);
    const out = name === "typesys_engineer_scaffold" ? insideRoot(root, args.out) : undefined;
    const parsed = await readSpec(file);
    if (!parsed.spec) return { ok: false, diagnostics: parsed.diagnostics };
    const loaded = await tryLoadHost(parsed.spec, path.dirname(file), { within: root });
    if ("diagnostic" in loaded) return { ok: false, diagnostics: [loaded.diagnostic] };
    const { host, resolve, workflows } = loaded;
    try {
      const plan = await planMission(parsed.spec, host, resolve, workflows);
      if (!out) return { ...plan };
      if (!plan.ok) return { ok: false, plan, files: [] };
      return { ok: true, plan, dir: path.relative(root, out), files: await scaffoldMission(parsed.spec, host, out) };
    } finally {
      // A host may start services of its own (the sortie host starts three); they go with the call.
      await (host as { services?: { stop(): Promise<void> } }).services?.stop().catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function draftTool(root: string, args: Record<string, unknown>): Promise<{ ok: boolean } & Record<string, unknown>> {
  const list = (v: unknown, field: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${field} is a list of paths`);
    return (v as string[]).map((p) => insideRoot(root, p));
  };
  const brief = insideRoot(root, args.brief);
  const out = insideRoot(root, args.out);
  const parsed = JSON.parse(await readFile(brief, "utf8")) as { host?: { module?: string } };
  // The brief names code to run: a path module must be inside the root, as for a mission (and `within` refuses a specifier climbing out).
  if (typeof parsed.host?.module === "string" && (parsed.host.module.startsWith(".") || path.isAbsolute(parsed.host.module))) insideRoot(root, path.resolve(path.dirname(brief), parsed.host.module));
  const argv = ["draft", brief, "--out", out, ...list(args.answers, "answers").flatMap((a) => ["--answer", a]), ...list(args.feedback, "feedback").flatMap((f) => ["--feedback", f]), "--json"];
  let printed = "";
  const code = await engineerCommand(argv, (line) => (printed = line), { within: root });
  const result = JSON.parse(printed) as Record<string, unknown>;
  if (code === 2) return { ok: true, answerNeeded: true, request: await readFile(insideRoot(root, String(result.answerNeeded)), "utf8") };
  return { ...result, ok: code === 0, out: path.relative(root, out) };
}

/** The MCP server; connect it to a transport (`mcp-bin.ts` uses stdio). */
export function createEngineerServer(root: string): Server {
  const server = new Server({ name: "typesys-engineer", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...ENGINEER_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callEngineerTool(root, request.params.name, request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok };
  });
  return server;
}
