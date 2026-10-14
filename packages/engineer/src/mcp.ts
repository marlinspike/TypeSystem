import path from "node:path";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { tryLoadHost } from "./host.js";
import { parseMission } from "./mission.js";
import { planMission } from "./plan.js";
import { scaffoldMission } from "./scaffold.js";
import { verifyMission } from "./verify.js";

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
  }
];

const escapes = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

/** The real path of `p`: symlinks followed as far as the path exists, the rest appended as written. */
function realOf(p: string): string {
  const rest: string[] = [];
  let at = p;
  for (;;) {
    try {
      return path.join(realpathSync(at), ...rest.reverse());
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return p;
      rest.push(path.basename(at));
      at = parent;
    }
  }
}

/**
 * `p` inside `root`, or an error: an agent's path never leaves the tree the
 * server was started on, by `..` or by a symlink it leads through.
 */
export function insideRoot(root: string, p: unknown): string {
  if (typeof p !== "string" || p === "") throw new Error("a path is required");
  const abs = path.resolve(root, p);
  if (escapes(path.relative(path.resolve(root), abs)) || escapes(path.relative(realOf(path.resolve(root)), realOf(abs)))) throw new Error(`${p} is outside the server's root`);
  return abs;
}

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
