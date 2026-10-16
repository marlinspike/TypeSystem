import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { insideRoot } from "@typesys/devkit";
import { onboardCommand } from "./command.js";

const path_ = (description: string) => ({ type: "string", description: `${description}, relative to the server's root` });
const paths = (description: string) => ({ type: "array", items: { type: "string" }, description: `${description}, relative to the server's root` });

/**
 * Onboarding as MCP tools (ADR-0076), for a coding agent acting as the
 * development model: collect evidence, read the refinement request, answer
 * it, and propose; a person reviews. Like the engineer tools it is a
 * developer tool, separate from the governed runtime's server: every path
 * is confined to `root`, and a database's connection string is read only
 * from the server's environment, by the variable an agent names.
 */
export const ONBOARD_TOOLS: readonly Tool[] = [
  {
    name: "typesys_onboard_collect",
    description: "Read one source's metadata (no rows) into a sources file: a PostgreSQL catalog (connection string from the environment variable named), an OpenAPI document (file or URL), or JSON Schemas. Each call adds or replaces its source.",
    inputSchema: {
      type: "object",
      required: ["out"],
      additionalProperties: false,
      properties: {
        out: path_("The sources file"),
        source: { type: "string", description: "The source's id, e.g. mxdb" },
        system: { type: "string", description: "The system's name, as provenance reports it" },
        postgres: { type: "string", description: "Environment variable holding the connection string" },
        schemas: { type: "array", items: { type: "string" } },
        openapi: { type: "string", description: "An OpenAPI document: a URL, or a path relative to the root" },
        jsonSchemas: paths("JSON Schema files"),
        keys: { type: "object", additionalProperties: { type: "string" }, description: "Title → key field, for JSON Schemas" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "typesys_onboard_request",
    description: "The refinement request a development model is sent for these sources: answer it yourself, as JSON matching its schema, write the answer to a file, then call typesys_onboard_propose with it.",
    inputSchema: { type: "object", required: ["sources", "domain"], additionalProperties: false, properties: { sources: path_("The sources file"), domain: { type: "string" }, markings: { type: "array", items: { type: "string" }, description: "Markings of the metadata itself, when it is classified" } } },
    annotations: { readOnlyHint: true }
  },
  {
    name: "typesys_onboard_propose",
    description: "Baseline, your refinement (checked against the evidence: what it cannot support is refused), what was approved before, the review, and verification. Writes proposal.json, pending.json, approved.json, pack.json, adapters.json and checks.json to `out`. Nothing is approved until a person reviews.",
    inputSchema: {
      type: "object",
      required: ["sources", "domain", "out"],
      additionalProperties: false,
      properties: { sources: path_("The sources file"), domain: { type: "string" }, out: path_("The output directory"), answer: path_("Your refinement answer"), review: path_("The review file"), approved: path_("approved.json from the last run"), previous: path_("pack.json from the last run"), version: { type: "string" }, markings: { type: "array", items: { type: "string" }, description: "Markings of the metadata itself, when it is classified" } }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }
];

/** Runs one onboarding tool; the result is JSON, and an error is a `{ ok: false, error }` result. */
export async function callOnboardTool(root: string, name: string, args: Record<string, unknown>, env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ ok: boolean } & Record<string, unknown>> {
  try {
    const p = (v: unknown) => insideRoot(root, v);
    const opt = (flag: string, v: unknown, asPath = true) => (v === undefined ? [] : [flag, asPath ? p(v) : typeof v === "string" ? v : JSON.stringify(v)]);
    const markings = Array.isArray(args.markings) ? args.markings.flatMap((m) => ["--marking", String(m)]) : [];
    let argv: string[];
    if (name === "typesys_onboard_collect") {
      const openapi = typeof args.openapi === "string" && /^https?:\/\//.test(args.openapi) ? ["--openapi", args.openapi] : opt("--openapi", args.openapi);
      const schemas = Array.isArray(args.schemas) ? args.schemas.flatMap((s) => ["--schema", String(s)]) : [];
      const json = Array.isArray(args.jsonSchemas) ? args.jsonSchemas.flatMap((f) => ["--json-schema", p(f)]) : [];
      const keys = args.keys && typeof args.keys === "object" ? Object.entries(args.keys as Record<string, unknown>).flatMap(([k, v]) => ["--key", `${k}=${String(v as string)}`]) : [];
      argv = ["collect", ...opt("--out", args.out), ...opt("--source", args.source, false), ...opt("--system", args.system, false), ...opt("--postgres", args.postgres, false), ...schemas, ...openapi, ...json, ...keys];
    } else if (name === "typesys_onboard_request") {
      argv = ["request", p(args.sources), ...opt("--domain", args.domain, false), ...markings];
    } else if (name === "typesys_onboard_propose") {
      argv = ["propose", p(args.sources), ...opt("--domain", args.domain, false), ...opt("--out", args.out), ...opt("--answer", args.answer), ...opt("--review", args.review), ...opt("--approved", args.approved), ...opt("--previous", args.previous), ...opt("--version", args.version, false), ...markings];
    } else return { ok: false, error: `Unknown tool ${name}` };
    let printed = "";
    const code = await onboardCommand([...argv, "--json"], (line) => (printed = line), env, { within: root });
    const result = JSON.parse(printed) as Record<string, unknown>;
    if (name === "typesys_onboard_request" && code === 0) return { ok: true, request: `SYSTEM:\n${String(result.system)}\n\n${String(result.prompt)}`, schema: result.schema };
    if (name === "typesys_onboard_propose" && typeof args.out === "string") return { ...result, ok: code === 0, out: path.relative(root, p(args.out)) };
    return { ...result, ok: code === 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The MCP server; connect it to a transport (`mcp-bin.ts` uses stdio). */
export function createOnboardServer(root: string): Server {
  const server = new Server({ name: "typesys-onboard", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...ONBOARD_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callOnboardTool(root, request.params.name, request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok };
  });
  return server;
}

