import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthorizationError, NotFoundError, PreconditionFailedError, type Identity, type TypeDefinition } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { createServer as createMcpServer } from "@typesys/mcp-server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IDENTITY_KEYS = ["maintainer", "viewer", "anonymous"] as const;
type IdentityKey = (typeof IDENTITY_KEYS)[number];

function isIdentityKey(value: unknown): value is IdentityKey {
  return typeof value === "string" && (IDENTITY_KEYS as readonly string[]).includes(value);
}

function resolveIdentity(key: unknown): Identity {
  return isIdentityKey(key) ? demoIdentities[key] : demoIdentities.anonymous;
}

function describeType(typeDef: TypeDefinition) {
  return {
    name: typeDef.name,
    version: typeDef.version,
    description: typeDef.description,
    extends: typeDef.extends,
    traits: typeDef.traits,
    relationships: typeDef.relationships.map((r) => ({
      name: r.name,
      targetType: r.targetType,
      cardinality: r.cardinality,
      inverseName: r.inverseName
    })),
    actionNames: typeDef.actionNames,
    computedPropertyNames: typeDef.computedProperties.map((c) => c.name),
    propertyPolicies: typeDef.schema["x-policy"]?.propertyPolicies ?? {},
    schema: typeDef.schema
  };
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof AuthorizationError) {
    res.status(403).json({ error: "AuthorizationError", message: err.message, reason: err.reason });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: "NotFoundError", message: err.message });
    return;
  }
  if (err instanceof PreconditionFailedError) {
    res.status(422).json({ error: "PreconditionFailedError", message: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "InternalError", message: err instanceof Error ? err.message : String(err) });
}

async function main(): Promise<void> {
  const testbed = await buildAirforceTestbed();
  const { registry, runtime } = testbed;

  // Wire a second, MCP-protocol-shaped front door onto the SAME registry/runtime
  // instance, so the "MCP Console" tab proves identical governance, not just
  // similar-looking code, between the human web path and the AI-agent path.
  const mcpBundle = await createMcpServer(testbed);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "typesys-demo-web", version: "0.1.0" });
  await Promise.all([mcpClient.connect(clientTransport), mcpBundle.server.connect(serverTransport)]);

  const app = express();
  app.use(express.json());

  app.get("/api/identities", (_req: Request, res: Response) => {
    res.json(
      IDENTITY_KEYS.map((key) => ({
        key,
        subjectId: demoIdentities[key].subjectId,
        roles: demoIdentities[key].roles
      }))
    );
  });

  app.get("/api/types", async (_req: Request, res: Response) => {
    const types = await registry.listTypes();
    res.json(types.map(describeType));
  });

  app.get("/api/types/:name", async (req: Request, res: Response) => {
    const typeDef = await registry.getType(req.params.name as string);
    if (!typeDef) {
      res.status(404).json({ error: "NotFoundError", message: `Unknown type "${req.params.name}"` });
      return;
    }
    res.json(describeType(typeDef));
  });

  app.get("/api/objects/:typeName", async (req: Request, res: Response) => {
    try {
      const identity = resolveIdentity(req.query.identity);
      const result = await runtime.query({ type: req.params.typeName as string }, identity);
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/objects/:typeName/:objectId", async (req: Request, res: Response) => {
    try {
      const identity = resolveIdentity(req.query.identity);
      const object = await runtime.getObject(req.params.typeName as string, req.params.objectId as string, identity, {
        includeProvenance: true
      });
      res.json(object);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/objects/:typeName/:objectId/relationships/:relationshipName", async (req: Request, res: Response) => {
    try {
      const identity = resolveIdentity(req.query.identity);
      const related = await runtime.getRelationship(
        req.params.typeName as string,
        req.params.objectId as string,
        req.params.relationshipName as string,
        identity
      );
      res.json(related);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/query", async (req: Request, res: Response) => {
    try {
      const identity = resolveIdentity(req.query.identity);
      const result = await runtime.query(req.body, identity);
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/actions/:typeName", async (req: Request, res: Response) => {
    const identity = resolveIdentity(req.query.identity);
    const actions = await runtime.listActions(req.params.typeName as string, identity);
    res.json(
      actions.map(({ action, authorized }) => ({
        name: action.name,
        description: action.description,
        inputSchema: action.inputSchema,
        authorized
      }))
    );
  });

  app.post("/api/actions/:name/invoke", async (req: Request, res: Response) => {
    const identity = resolveIdentity(req.query.identity);
    try {
      const result = await runtime.invokeAction(req.params.name as string, req.body, identity);
      res.json({ ok: true, result });
    } catch (err) {
      if (err instanceof AuthorizationError || err instanceof PreconditionFailedError || err instanceof NotFoundError) {
        res.json({ ok: false, error: err.constructor.name, message: err.message });
        return;
      }
      sendError(res, err);
    }
  });

  app.get("/api/audit", async (_req: Request, res: Response) => {
    const events = await registry.listAuditEvents();
    res.json(events.slice(-200).reverse());
  });

  // MCP Console bridge: the exact same tool/resource calls an AI agent would make.
  app.get("/api/mcp/resources", async (_req: Request, res: Response) => {
    try {
      res.json(await mcpClient.listResources());
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/mcp/tools", async (_req: Request, res: Response) => {
    try {
      res.json(await mcpClient.listTools());
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/mcp/resource", async (req: Request, res: Response) => {
    try {
      res.json(await mcpClient.readResource({ uri: req.body.uri }));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/mcp/tool", async (req: Request, res: Response) => {
    try {
      res.json(await mcpClient.callTool({ name: req.body.name, arguments: req.body.arguments }));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.use(express.static(path.join(__dirname, "../public")));

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`TypeS demo running at http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
