import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { withSpan, type SemanticRegistry, type SemanticRuntime } from "@typesys/core";
import type { IdentityResolver } from "./auth.js";
import { readObject, readProvenance, readRelationship, readType, readTypes } from "./reads.js";
import { buildTypeListUri, buildTypeUri, parseResourceUri, telemetryResourceUri } from "./resource-uri.js";

function jsonContents(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Resources are read-only browsing of Types/objects/relationships/
 * provenance — Actions are Tools, registered separately (see ADR-0012). The
 * same five reads are also tools (ADR-0051); both call `reads.ts`.
 * Every read goes through the same SemanticRuntime/PolicyEngine as any
 * other consumer; there is no MCP-specific authorization logic here.
 */
export function registerResourceHandlers(
  server: Server,
  registry: SemanticRegistry,
  runtime: SemanticRuntime,
  resolveIdentity: IdentityResolver
): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const types = await registry.listTypes();
    return {
      resources: [
        { uri: buildTypeListUri(), name: "Semantic Types", description: "Every registered semantic type." },
        ...types.map((t) => ({
          uri: buildTypeUri(t.name),
          name: t.name,
          description: t.description ?? `Semantic definition for ${t.name}`
        }))
        // No object is listed: the registry says what Types exist, not which objects do. An object is found
        // with the `query` tool and read by URI (ADR-0050).
      ]
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    // One top-level span per MCP request, wrapping whichever SemanticRuntime call the
    // handler makes below — the runtime's own spans nest under this one automatically
    // (ADR-0017), rather than a second, MCP-specific instrumentation scheme.
    const redactErrors = runtime.redactsTelemetryIdentifiers;
    return withSpan("mcp.resources/read", { "mcp.resource.uri": telemetryResourceUri(uri, redactErrors) }, async () => {
      const { category, segments, token } = parseResourceUri(uri);
      const identity = await resolveIdentity(token);

      if (category === "types" && segments.length === 0) {
        return jsonContents(uri, await readTypes(registry));
      }

      if (category === "types" && segments.length === 1) {
        return jsonContents(uri, await readType(registry, segments[0]!));
      }

      if (category === "objects" && segments.length === 2) {
        const [typeName, objectId] = segments as [string, string];
        return jsonContents(uri, await readObject(runtime, typeName, objectId, identity));
      }

      if (category === "objects" && segments.length === 4 && segments[2] === "relationships") {
        const [typeName, objectId, , relationshipName] = segments as [string, string, string, string];
        return jsonContents(uri, await readRelationship(runtime, typeName, objectId, relationshipName, identity));
      }

      if (category === "objects" && segments.length === 4 && segments[2] === "provenance") {
        const [typeName, objectId, , propertyPath] = segments as [string, string, string, string];
        return jsonContents(uri, await readProvenance(runtime, typeName, objectId, propertyPath, identity));
      }

      throw new Error(`Unrecognized resource URI "${telemetryResourceUri(uri, false)}"`);
    }, { redactErrors });
  });
}
