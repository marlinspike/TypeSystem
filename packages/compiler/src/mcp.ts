import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { insideRoot } from "@typesys/devkit";
import { appCommand } from "./cli.js";

const dir = { type: "string", description: "The application's directory (holding app.json), relative to the server's root" } as const;

/**
 * The application compiler as MCP tools (ADR-0085), for an agent that
 * writes `app.json` and TypeScript extensions: learn the language, get the
 * model context, check, compile, build, verify and diff, each answering
 * with structured diagnostics at JSON Pointers. Like the engineer's tools
 * it reads and writes files and runs builds, so every path must be inside
 * `root`, and a host module given as a path must be too.
 */
export const APP_TOOLS: readonly Tool[] = [
  {
    name: "typesys_app_catalog",
    description: "Every primitive of the application IR (typesys.app/1): interface nodes, flow steps, effects, expression operators and reference scopes, each with its fields. Read it once before writing app.json.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "typesys_app_explain",
    description: "What a diagnostic code means and how to resolve it. Without a code, the list of codes.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "typesys_app_context",
    description: "The part of the governed model the application's requirement needs, as one of its callers is told of it and returned it (ADR-0078): Types, values the caller is never returned, relationships and Actions, within a token budget. Write the specification against this.",
    inputSchema: { type: "object", properties: { dir, as: { type: "string", description: "A caller named in app.json; default the first signed-in one" }, maxTokens: { type: "number" } }, required: ["dir"], additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "typesys_app_check",
    description: "Check app.json against the host's model and its policies as each caller. Returns {ok, diagnostics}: each {code, severity, at, message, hint, because}, `at` a JSON Pointer into app.json. Fix every error and check again; nothing is generated until there are none.",
    inputSchema: { type: "object", properties: { dir }, required: ["dir"], additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "typesys_app_compile",
    description: "Check, then generate the application: files under src/generated/ and server.ts whenever their content changes, typed stubs in src/extensions/ only when absent (they are yours to implement). Stops at a generated file edited by hand, naming it, unless force. Returns {ok, written, created, removed, diagnostics}.",
    inputSchema: { type: "object", properties: { dir, force: { type: "boolean" } }, required: ["dir"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "typesys_app_build",
    description: "Type-check every file of the compiled application with tsc (generated and handwritten) and bundle the client. A compile-error at src/generated/contracts-check.ts means an extension does not satisfy its contract in src/generated/contracts.ts.",
    inputSchema: { type: "object", properties: { dir }, required: ["dir"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "typesys_app_verify",
    description: "Compile, build, and run every acceptance check against a freshly started copy of the application: API checks as each caller, screen checks in Chromium. Returns {ok, stages, checks, diagnostics}; a failing check carries what was observed. Repair and verify again until ok.",
    inputSchema: { type: "object", properties: { dir }, required: ["dir"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "typesys_app_diff",
    description: "What changed between an earlier app.json and the one in dir, in the IR's own terms (pages, nodes, flows, steps, data, checks), what each change risks (a flow whose steps changed without a new version), the generated files it changes, and the acceptance checks that exercise it.",
    inputSchema: { type: "object", properties: { dir, against: { type: "string", description: "The earlier app.json, relative to the root" } }, required: ["dir", "against"], additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "typesys_app_migrate",
    description: "Translate a typesys.mission/1 spec into dir/app.json (ADR-0086): the same host, callers and acceptance checks, the workflow step for step under the same names, the views as tables, plus a form and an approval queue for the workflow. Returns {ok, app, diagnostics}; every change is a mission-translation note at its place in the mission. Refuses to replace an app.json unless force.",
    inputSchema: { type: "object", properties: { mission: { type: "string", description: "The mission.json, relative to the root" }, dir, force: { type: "boolean" } }, required: ["mission", "dir"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }
];

/** Runs one tool through the CLI's own code, so the tools and `typesys app` never disagree. */
export async function callAppTool(root: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean } & Record<string, unknown>> {
  try {
    const sub = name.replace(/^typesys_app_/, "");
    const argv: string[] = [sub];
    if (sub === "explain") {
      if (typeof args.code === "string") argv.push(args.code);
    } else if (sub !== "catalog") {
      if (!APP_TOOLS.some((t) => t.name === name)) return { ok: false, error: `Unknown tool ${name}` };
      if (sub === "migrate") argv.push(insideRoot(root, args.mission), "--out");
      argv.push(insideRoot(root, args.dir));
      if (sub === "migrate" && args.force === true) argv.push("--force");
      if (sub === "diff") argv.push("--against", insideRoot(root, args.against));
      if (sub === "compile" && args.force === true) argv.push("--force");
      if (sub === "context" && typeof args.as === "string") argv.push("--as", args.as);
      if (sub === "context" && typeof args.maxTokens === "number") argv.push("--max-tokens", String(args.maxTokens));
    }
    argv.push("--json");
    let printed = "";
    const code = await appCommand(argv, (s) => (printed = s), { within: root });
    const result = JSON.parse(printed) as Record<string, unknown>;
    return { ...result, ok: code === 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The MCP server; connect it to a transport (`mcp-bin.ts` uses stdio). */
export function createAppMcpServer(root: string): Server {
  const server = new Server({ name: "typesys-app", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...APP_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callAppTool(root, request.params.name, request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok };
  });
  return server;
}
