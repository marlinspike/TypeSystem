import { ListToolsRequestSchema, CallToolRequestSchema, type Tool, type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  semanticQuerySchema,
  aggregateQuerySchema,
  withSpan,
  type ActionDefinition,
  type Identity,
  type JsonSchema2020,
  type SemanticQuery,
  type SemanticAggregateQuery,
  type SemanticRegistry,
  type SemanticRuntime
} from "@typesys/core";
import type { IdentityResolver } from "./auth.js";
import { readObject, readProvenance, readRelationship, readType, readTypes } from "./reads.js";
import { AGGREGATE_OUTPUT, OBJECT_OUTPUT, PROVENANCE_OUTPUT, QUERY_OUTPUT, RELATIONSHIP_OUTPUT, TYPE_OUTPUT, TYPES_OUTPUT } from "./output-schemas.js";

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
 * Every tool TypeS itself provides is named with this prefix, and no Action
 * may be (ADR-0051), so a domain's Actions can never shadow a read. An
 * underscore, not a dot: the Claude and OpenAI tool-calling APIs accept only
 * `[A-Za-z0-9_-]` in a tool name, and many agent frameworks pass MCP tool
 * names straight through to them.
 */
export const RESERVED_TOOL_PREFIX = "typesys_";

/** The names `query` and `aggregate` had before ADR-0051. Accepted on call, never listed; removed in the next minor version. */
const DEPRECATED_ALIASES: Readonly<Record<string, string>> = {
  query: `${RESERVED_TOOL_PREFIX}query`,
  aggregate: `${RESERVED_TOOL_PREFIX}aggregate`
};

/** What every built-in tool tells a client: it reads, the same call twice changes nothing, and it reaches only the registry's systems. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * An Action's annotations, from what its definition already declares
 * (ADR-0051). All four are set, since MCP's defaults (destructive, not
 * idempotent, open world) would otherwise speak for the Action. An
 * `external` side effect is reported as possibly destructive: TypeS cannot
 * see what the external system does with it. Hints only — the runtime
 * enforces policy whatever a client makes of them.
 */
export function actionAnnotations(action: Pick<ActionDefinition, "sideEffects" | "idempotency">): ToolAnnotations {
  return {
    readOnlyHint: action.sideEffects === "none",
    destructiveHint: action.sideEffects === "mutates" || action.sideEffects === "external",
    idempotentHint: action.idempotency !== "none",
    openWorldHint: action.sideEffects === "external"
  };
}

type Args = Record<string, unknown>;

/** The read tools take ids and names, never shapes, so their arguments are checked here rather than by the runtime. */
function strings<const K extends string>(tool: string, args: Args, keys: readonly K[]): Record<K, string> {
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== "string" || value === "") throw new Error(`${tool}: "${key}" must be a non-empty string`);
  }
  return args as Record<K, string>;
}

function stringArgs(keys: Record<string, string>): JsonSchema2020 {
  return {
    type: "object",
    required: Object.keys(keys),
    properties: Object.fromEntries(Object.entries(keys).map(([key, description]) => [key, { type: "string", description }]))
  };
}

interface BuiltInTool {
  description: string;
  inputSchema: JsonSchema2020;
  outputSchema: JsonSchema2020;
  /** Returns the tool's `structuredContent`, which is also its text. */
  run(args: Args, identity: Identity): Promise<Record<string, unknown>>;
}

function builtInTools(registry: SemanticRegistry, runtime: SemanticRuntime): Record<string, BuiltInTool> {
  const p = RESERVED_TOOL_PREFIX;
  return {
    [`${p}list_types`]: {
      description: "List every registered semantic Type, with its schema, relationships, Actions, and computed properties.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: TYPES_OUTPUT,
      run: async () => ({ types: await readTypes(registry) })
    },
    [`${p}describe_type`]: {
      description: "Describe a semantic Type: its JSON Schema, relationships, Actions, and computed properties.",
      inputSchema: stringArgs({ type: "The Type's qualified name (domain.Type), as resources/list gives it." }),
      outputSchema: TYPE_OUTPUT,
      run: async (args) => {
        const { type } = strings(`${p}describe_type`, args, ["type"]);
        return readType(registry, type);
      }
    },
    [`${p}get_object`]: {
      description: "Read one object by Type and id, with the provenance of each value. Properties you may not read are left out.",
      inputSchema: stringArgs({ type: "The object's Type.", id: "The object's id." }),
      outputSchema: OBJECT_OUTPUT,
      run: async (args, identity) => {
        const { type, id } = strings(`${p}get_object`, args, ["type", "id"]);
        return { ...(await readObject(runtime, type, id, identity)) };
      }
    },
    [`${p}get_relationship`]: {
      description: "Read the objects one object is related to through a named relationship. Objects you may not read are left out.",
      inputSchema: stringArgs({ type: "The source object's Type.", id: "The source object's id.", relationship: "The relationship's name." }),
      outputSchema: RELATIONSHIP_OUTPUT,
      run: async (args, identity) => {
        const { type, id, relationship } = strings(`${p}get_relationship`, args, ["type", "id", "relationship"]);
        return { objects: await readRelationship(runtime, type, id, relationship, identity) };
      }
    },
    [`${p}get_provenance`]: {
      description: "Where one property's value came from: source system, record, and time, and for a computed property, each input's.",
      inputSchema: stringArgs({ type: "The object's Type.", id: "The object's id.", property: "The property's name." }),
      outputSchema: PROVENANCE_OUTPUT,
      run: async (args, identity) => {
        const { type, id, property } = strings(`${p}get_provenance`, args, ["type", "id", "property"]);
        return { provenance: await readProvenance(runtime, type, id, property, identity) };
      }
    },
    [`${p}query`]: {
      description: "Run a structured semantic query against a Type, optionally including related objects.",
      // The exact schema (and limits) SemanticRuntime.query enforces, so an agent is told the real bounds.
      inputSchema: semanticQuerySchema(runtime.queryLimits),
      outputSchema: QUERY_OUTPUT,
      // Unchecked JSON is fine here: SemanticRuntime validates each shape before doing anything else.
      run: async (args, identity) => ({ ...(await runtime.query(args as unknown as SemanticQuery, identity)) })
    },
    [`${p}aggregate`]: {
      description: "Run a grouped aggregation (count/sum/avg/min/max, optional groupBy) against a Type.",
      inputSchema: aggregateQuerySchema(runtime.queryLimits),
      outputSchema: AGGREGATE_OUTPUT,
      run: async (args, identity) => ({ ...(await runtime.aggregate(args as unknown as SemanticAggregateQuery, identity)) })
    }
  };
}

/**
 * Actions map 1:1 onto MCP tools, beside TypeS's own read, query, and
 * aggregate tools (ADR-0012, ADR-0051). Every call routes through the same
 * SemanticRuntime/PolicyEngine as any other consumer.
 */
export function registerToolHandlers(
  server: Server,
  registry: SemanticRegistry,
  runtime: SemanticRuntime,
  resolveIdentity: IdentityResolver
): void {
  const builtIns = builtInTools(registry, runtime);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const actions = await registry.listActions();
    const squatting = actions.filter((a) => a.name.startsWith(RESERVED_TOOL_PREFIX)).map((a) => a.name);
    // Refuse loudly rather than hide the Action: a registry holding one is misconfigured, and listing the
    // rest would leave an agent unable to tell why an Action it was told about is missing.
    if (squatting.length > 0) {
      throw new Error(`Action names may not start with the reserved prefix "${RESERVED_TOOL_PREFIX}": ${squatting.join(", ")}`);
    }
    const tools: Tool[] = [
      ...actions.map((action) => ({
        name: action.name,
        description: action.description,
        inputSchema: withAuthToken(action.inputSchema) as Tool["inputSchema"],
        outputSchema: action.outputSchema as Tool["outputSchema"],
        annotations: actionAnnotations(action)
      })),
      ...Object.entries(builtIns).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: withAuthToken(tool.inputSchema) as Tool["inputSchema"],
        outputSchema: tool.outputSchema as Tool["outputSchema"],
        annotations: READ_ONLY
      }))
    ];
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    // One top-level span per MCP tool call — see the matching comment in resources.ts.
    return withSpan("mcp.tools/call", { "mcp.tool.name": name }, async () => {
      const { authToken, ...rest } = (rawArgs ?? {}) as Args & { authToken?: string };
      const caller = await resolveIdentity(authToken);

      try {
        const builtIn = builtIns[DEPRECATED_ALIASES[name] ?? name];
        if (builtIn) {
          // Parsed back from the text, so both are exactly what crosses the wire (no undefined members).
          const text = JSON.stringify(await builtIn.run(rest, caller), null, 2);
          return { content: [{ type: "text" as const, text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
        }
        if (name.startsWith(RESERVED_TOOL_PREFIX)) throw new Error(`Unknown tool "${name}"`);

        const result = await runtime.invokeAction(name, rest, caller);
        const structuredContent = result !== null && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
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
