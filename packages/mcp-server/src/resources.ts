import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { withSpan, type SemanticRegistry, type SemanticRuntime, type TypeDefinition } from "@typesys/core";
import { resolveIdentity } from "./auth.js";
import { buildObjectUri, buildTypeListUri, buildTypeUri, parseResourceUri } from "./resource-uri.js";

function describeType(typeDef: TypeDefinition) {
  return {
    name: typeDef.name,
    version: typeDef.version,
    description: typeDef.description,
    extends: typeDef.extends,
    traits: typeDef.traits,
    schema: typeDef.schema,
    relationships: typeDef.relationships.map((r) => ({
      name: r.name,
      targetType: r.targetType,
      cardinality: r.cardinality,
      inverseName: r.inverseName
    })),
    actionNames: typeDef.actionNames,
    computedPropertyNames: typeDef.computedProperties.map((c) => c.name),
    deprecated: typeDef.deprecated,
    aliases: typeDef.aliases
  };
}

function jsonContents(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Resources are read-only browsing of Types/objects/relationships/
 * provenance — Actions are Tools, registered separately (see ADR-0012).
 * Every read goes through the same SemanticRuntime/PolicyEngine as any
 * other consumer; there is no MCP-specific authorization logic here.
 */
export function registerResourceHandlers(server: Server, registry: SemanticRegistry, runtime: SemanticRuntime): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const types = await registry.listTypes();
    return {
      resources: [
        { uri: buildTypeListUri(), name: "Semantic Types", description: "Every registered semantic type." },
        ...types.map((t) => ({
          uri: buildTypeUri(t.name),
          name: t.name,
          description: t.description ?? `Semantic definition for ${t.name}`
        })),
        {
          uri: buildObjectUri("airforce.Aircraft", "AF86-0147"),
          name: "Aircraft AF86-0147",
          description: "A sample Aircraft object (pass ?token=demo-maintainer-token or demo-viewer-token)."
        }
      ]
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    // One top-level span per MCP request, wrapping whichever SemanticRuntime call the
    // handler makes below — the runtime's own spans nest under this one automatically
    // (ADR-0017), rather than a second, MCP-specific instrumentation scheme.
    return withSpan("mcp.resources/read", { "mcp.resource.uri": uri }, async () => {
      const { category, segments, token } = parseResourceUri(uri);
      const identity = resolveIdentity(token);

      if (category === "types" && segments.length === 0) {
        const types = await registry.listTypes();
        return jsonContents(uri, types.map(describeType));
      }

      if (category === "types" && segments.length === 1) {
        const typeDef = await registry.getType(segments[0]!);
        if (!typeDef) throw new Error(`Unknown type "${segments[0]}"`);
        return jsonContents(uri, describeType(typeDef));
      }

      if (category === "objects" && segments.length === 2) {
        const [typeName, objectId] = segments as [string, string];
        const object = await runtime.getObject(typeName, objectId, identity, { includeProvenance: true });
        return jsonContents(uri, object);
      }

      if (category === "objects" && segments.length === 4 && segments[2] === "relationships") {
        const [typeName, objectId, , relationshipName] = segments as [string, string, string, string];
        const related = await runtime.getRelationship(typeName, objectId, relationshipName, identity);
        return jsonContents(uri, related);
      }

      if (category === "objects" && segments.length === 4 && segments[2] === "provenance") {
        const [typeName, objectId, , propertyPath] = segments as [string, string, string, string];
        const provenance = await runtime.getProvenance(typeName, objectId, propertyPath, identity);
        return jsonContents(uri, provenance);
      }

      throw new Error(`Unrecognized resource URI "${uri}"`);
    });
  });
}
