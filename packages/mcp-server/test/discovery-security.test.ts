import type { Server as HttpServer } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Discovery, ModelDescription } from "@typesys/core";
import { createApiApp } from "@typesys/http";
import { buildAirforceTestbed, demoIdentities, resolveDemoIdentity, type AirforceTestbed } from "@typesys/domain-airforce";
import { createServer } from "../src/server.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-transport.js";
import { buildTypeListUri } from "../src/resource-uri.js";

/**
 * Discovery is the runtime's decision (ADR-0068), so a caller is told the
 * same model by the runtime, the REST API, and MCP's tools and resources,
 * over stdio-style in-band tokens and over HTTP headers alike.
 */
const TOKEN = { maintainer: "demo-maintainer-token", viewer: "demo-viewer-token", anonymous: undefined } as const;
type Who = keyof typeof TOKEN;
const IDENTITY = { maintainer: demoIdentities.maintainer, viewer: demoIdentities.viewer, anonymous: demoIdentities.anonymous };

interface World {
  testbed: AirforceTestbed;
  rest: (path: string, who: Who, body?: unknown) => Promise<{ status: number; body: unknown }>;
  /** MCP with the token carried in each call, as over stdio. */
  mcp: Client;
  /** MCP over HTTP with the token in the Authorization header. */
  mcpOverHttp: (who: Who) => Promise<Client>;
  close: () => Promise<void>;
}

async function world(discovery: Discovery): Promise<World> {
  const testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { discovery } });
  const app = createApiApp({ backend: testbed, identityResolver: resolveDemoIdentity, onError: () => {} });
  let api!: HttpServer;
  await new Promise<void>((r) => (api = app.listen(0, "127.0.0.1", () => r())));
  const apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const rest = async (path: string, who: Who, body?: unknown) => {
    const token = TOKEN[who];
    const res = await fetch(`${apiBase}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, body: (await res.json()) };
  };

  const { server } = createServer(testbed, resolveDemoIdentity);
  const mcp = new Client({ name: "discovery-test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(c), server.connect(s)]);

  const running: RunningHttpServer = await startHttpServer(0, { backend: testbed, identityResolver: resolveDemoIdentity });
  const clients: Client[] = [];
  const mcpOverHttp = async (who: Who) => {
    const token = TOKEN[who];
    const client = new Client({ name: "discovery-http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${running.port}/mcp`), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } }));
    clients.push(client);
    return client;
  };
  const close = async () => {
    await Promise.allSettled([...clients.map((cl) => cl.close()), mcp.close(), running.close(), new Promise<void>((r) => api.close(() => r()))]);
  };
  return { testbed, rest, mcp, mcpOverHttp, close };
}

async function tool(client: Client, name: string, args: Record<string, unknown>, who: Who) {
  const token = TOKEN[who];
  const result = await client.callTool({ name, arguments: { ...args, ...(token ? { authToken: token } : {}) } });
  return { isError: result.isError === true, text: (result.content as { text: string }[])[0]!.text, structured: result.structuredContent as Record<string, unknown> | undefined };
}

/** What MCP's list_types says, in the terms a model description uses. */
function fromTypeDocuments(types: { name: string; schema: { properties?: Record<string, unknown> }; relationships: { name: string }[]; actionNames: string[]; computedPropertyNames: string[] }[]) {
  return types.map((t) => ({ name: t.name, properties: Object.keys(t.schema.properties ?? {}).sort(), relationships: t.relationships.map((r) => r.name), actions: t.actionNames, computed: t.computedPropertyNames }));
}

function fromModel(model: ModelDescription, own: (name: string) => string[]) {
  // MCP describes a Type's own schema; the model composes base and traits in, so compare MCP's own properties with the model's.
  return model.types.map((t) => ({ name: t.name, properties: Object.keys(t.properties).filter((p) => own(t.name).includes(p)).sort(), relationships: t.relationships.map((r) => r.name), actions: t.actions, computed: t.computed.map((c) => c.name) }));
}

describe("need-to-know over every transport (ADR-0068)", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("need-to-know");
  });
  afterAll(() => w.close());

  const ownProperties = async (name: string) => Object.keys((await w.testbed.registry.getType(name))?.schema.properties ?? {});

  for (const who of ["maintainer", "viewer"] as const) {
    it(`the ${who} is told one model by the runtime, the REST API, MCP tools and MCP resources`, async () => {
      const model = await w.testbed.runtime.describeModel(IDENTITY[who]);
      expect((await w.rest("/model", who)).body).toEqual(model);

      const owns = new Map(await Promise.all(model.types.map(async (t) => [t.name, await ownProperties(t.name)] as const)));
      const expected = fromModel(model, (n) => owns.get(n) ?? []);
      const listed = await tool(w.mcp, "typesys_list_types", {}, who);
      expect(fromTypeDocuments(listed.structured!.types as never)).toEqual(expected);
      const resource = await w.mcp.readResource({ uri: buildTypeListUri(TOKEN[who]) });
      expect(fromTypeDocuments(JSON.parse((resource.contents[0] as { text: string }).text) as never)).toEqual(expected);

      for (const task of ["close a work order", "where is the jet deployed", "maintenance status"]) {
        const overMcp = await tool(w.mcp, "typesys_discover", { task, limit: 5 }, who);
        expect(overMcp.structured!.matches).toEqual((await w.rest("/discover", who, { task, limit: 5 })).body);
      }

      const openapi = (await w.rest("/openapi.json", who)).body as { paths: Record<string, unknown> };
      const actionPaths = Object.keys(openapi.paths).filter((p) => p.startsWith("/actions/") && p.endsWith("/invoke"));
      expect(actionPaths).toEqual(model.actions.map((a) => `/actions/${a.name}/invoke`));
    });
  }

  it("a viewer asking for a Type's withheld member, or an Action, gets what a name that does not exist gets", async () => {
    const query = { type: "airforce.Aircraft", filter: { property: "deploymentLocation", operator: "eq", value: "x" } };
    const overMcp = await tool(w.mcp, "typesys_validate_query", { query }, "viewer");
    const overRest = (await w.rest("/query/validate", "viewer", { query })).body as { diagnostics: unknown[] };
    expect(overMcp.structured!.diagnostics).toEqual(overRest.diagnostics);
    expect(overRest.diagnostics.length).toBeGreaterThan(0);
    const unknown = await tool(w.mcp, "typesys_validate_query", { query: { ...query, filter: { ...query.filter, property: "noSuchThing" } } }, "viewer");
    expect(unknown.structured!.valid).toBe(overMcp.structured!.valid);

    const hidden = await tool(w.mcp, "typesys_describe_type", { type: "core.Asset" }, "viewer");
    const missing = await tool(w.mcp, "typesys_describe_type", { type: "core.Nope" }, "viewer");
    expect(hidden.isError && missing.isError).toBe(true);
    expect(hidden.text.replace("core.Asset", "X")).toBe(missing.text.replace("core.Nope", "X"));
    expect((await tool(w.mcp, "typesys_list_actions", { type: "airforce.MaintenanceEvent" }, "viewer")).structured).toEqual({ actions: [] });
  });

  it("an anonymous caller is refused over REST and MCP, is listed no Type resource, and is offered no Action tool", async () => {
    expect((await w.rest("/model", "anonymous")).status).toBe(403);
    expect((await w.rest("/openapi.json", "anonymous")).status).toBe(403);
    expect((await w.rest("/discover", "anonymous", { task: "aircraft" })).status).toBe(403);
    expect((await tool(w.mcp, "typesys_list_types", {}, "anonymous")).isError).toBe(true);
    expect((await tool(w.mcp, "typesys_discover", { task: "aircraft" }, "anonymous")).isError).toBe(true);
    const { resources } = await w.mcp.listResources();
    expect(resources.map((r) => r.uri)).toEqual(["typesys://types"]);
    const { tools } = await w.mcp.listTools();
    expect(tools.every((t) => t.name.startsWith("typesys_"))).toBe(true);
  });

  it("over HTTP, tools/list and resources/list follow the bearer: the maintainer is offered both Actions, the viewer neither", async () => {
    const maintainer = await w.mcpOverHttp("maintainer");
    expect((await maintainer.listTools()).tools.filter((t) => !t.name.startsWith("typesys_")).map((t) => t.name).sort()).toEqual(["CreateMaintenanceWorkOrder", "UpdateWorkOrderStatus"]);
    const viewer = await w.mcpOverHttp("viewer");
    expect((await viewer.listTools()).tools.filter((t) => !t.name.startsWith("typesys_"))).toEqual([]);
    expect((await viewer.listResources()).resources.map((r) => r.uri)).toEqual(["typesys://types", ...(await w.testbed.runtime.describeModel(demoIdentities.viewer)).types.map((t) => `typesys://types/${t.name}`)]);
  });

  it("typesys_invoke_action reaches an Action tools/list did not offer, and is decided by the runtime like its own tool", async () => {
    const input = { maintenanceEventId: "EVT-9002", assignedTo: "SSgt Rivera" };
    const refused = await tool(w.mcp, "typesys_invoke_action", { action: "CreateMaintenanceWorkOrder", input }, "viewer");
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Not authorized/);
    const done = await tool(w.mcp, "typesys_invoke_action", { action: "CreateMaintenanceWorkOrder", input }, "maintainer");
    expect(done.isError).toBe(false);
    expect(done.structured).toMatchObject({ result: { maintenanceEventId: "EVT-9002" } });
  });
});

describe("what a Type description never carries, in any mode (ADR-0032, ADR-0068)", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("open");
  });
  afterAll(() => w.close());

  it("no policy names, markings, data sources or bindings, though open discovery tells anyone every Type", async () => {
    const described = await tool(w.mcp, "typesys_describe_type", { type: "airforce.Aircraft" }, "anonymous");
    expect(described.isError).toBe(false);
    for (const keyword of ["x-policy", "x-provenance", "x-relationships", "x-computed", "x-actions", "airforce.read-aircraft", "airforce.maintainer-only", "dataSourceId", "computeNeedsAttention", "\"SECRET\""]) {
      expect(described.text, keyword).not.toContain(keyword);
    }
    expect(described.structured).toMatchObject({ relationships: [{ name: "components" }, { name: "maintenance" }], computedPropertyNames: ["readinessStatus", "needsAttention"] });
    const all = await tool(w.mcp, "typesys_list_types", {}, "anonymous");
    expect(all.text).not.toContain("x-policy");
    expect(all.text).not.toContain("x-provenance");
  });

  it("open lists every Action tool to anyone, as before", async () => {
    const { tools } = await w.mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["CreateMaintenanceWorkOrder", "UpdateWorkOrderStatus"]));
  });
});
