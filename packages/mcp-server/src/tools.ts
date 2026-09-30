import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { semanticQuerySchema, aggregateQuerySchema, withSpan, type JsonSchema2020, type SemanticQuery, type SemanticAggregateQuery, type SemanticRegistry, type SemanticRuntime } from "@typesys/core";
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
        // The exact schema (and limits) SemanticRuntime.query enforces, so an agent is told the real bounds.
        inputSchema: withAuthToken(semanticQuerySchema(runtime.queryLimits)) as Tool["inputSchema"]
      },
      {
        name: "aggregate",
        description: "Run a grouped aggregation (count/sum/avg/min/max, optional groupBy) against a Type.",
        inputSchema: withAuthToken(aggregateQuerySchema(runtime.queryLimits)) as Tool["inputSchema"]
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
        // Unchecked JSON is fine here: SemanticRuntime validates each shape before doing anything else.
        let result: unknown;
        let structuredContent: Record<string, unknown> | undefined;
        if (name === "query") {
          result = await runtime.query(rest as unknown as SemanticQuery, identity);
        } else if (name === "aggregate") {
          result = await runtime.aggregate(rest as unknown as SemanticAggregateQuery, identity);
        } else {
          result = await runtime.invokeAction(name, rest, identity);
          structuredContent = result !== null && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(structuredContent ? { structuredContent } : {})
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }, { redactErrors: runtime.redactsTelemetryIdentifiers });
  });
}
