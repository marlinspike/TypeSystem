import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { withSpan, type JsonSchema2020, type SemanticQuery, type SemanticRegistry, type SemanticRuntime } from "@typesys/core";
import type { IdentityResolver } from "./auth.js";

const AUTH_TOKEN_FIELD = {
  authToken: { type: "string", description: "Bearer token identifying the caller (see ADR-0009/0012)." }
};

function withAuthToken(schema: JsonSchema2020): JsonSchema2020 {
  return {
    ...schema,
    type: "object",
    properties: { ...(schema.properties ?? {}), ...AUTH_TOKEN_FIELD }
  };
}

const QUERY_TOOL_INPUT_SCHEMA: JsonSchema2020 = withAuthToken({
  type: "object",
  properties: {
    type: { type: "string", description: "Logical type name to query, e.g. airforce.Aircraft" },
    filter: { description: "A QueryFilter: {property, operator, value} or {and:[...]}/{or:[...]}" },
    include: { type: "array", items: { type: "object" }, description: "Relationships to navigate and include inline" },
    includeProvenance: { type: "boolean" },
    limit: { type: "number" }
  },
  required: ["type"]
});

/**
 * Actions map 1:1 onto MCP tools, plus one generic `query` tool for the
 * structured query DSL (see ADR-0011/0012). Every call routes through the
 * same SemanticRuntime/PolicyEngine as any other consumer.
 */
export function registerToolHandlers(
  server: Server,
  registry: SemanticRegistry,
  runtime: SemanticRuntime,
  resolveIdentity: IdentityResolver
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const actions = await registry.listActions();
    const tools: Tool[] = [
      ...actions.map((action) => ({
        name: action.name,
        description: action.description,
        inputSchema: withAuthToken(action.inputSchema) as Tool["inputSchema"],
        outputSchema: action.outputSchema as Tool["outputSchema"]
      })),
      {
        name: "query",
        description: "Run a structured semantic query against a Type, optionally including related objects.",
        inputSchema: QUERY_TOOL_INPUT_SCHEMA as Tool["inputSchema"]
      }
    ];
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    // One top-level span per MCP tool call — see the matching comment in resources.ts.
    return withSpan("mcp.tools/call", { "mcp.tool.name": name }, async () => {
      const { authToken, ...rest } = (rawArgs ?? {}) as Record<string, unknown> & { authToken?: string };
      const identity = await resolveIdentity(authToken);

      try {
        const isQuery = name === "query";
        const result = isQuery
          ? await runtime.query(rest as unknown as SemanticQuery, identity)
          : await runtime.invokeAction(name, rest, identity);
        const structuredContent =
          !isQuery && result !== null && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(structuredContent ? { structuredContent } : {})
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    });
  });
}
