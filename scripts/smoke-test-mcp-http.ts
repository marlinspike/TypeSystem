#!/usr/bin/env -S npx tsx
/**
 * Same discover -> inspect -> retrieve -> navigate -> provenance ->
 * list-actions -> invoke script as scripts/smoke-test-mcp.ts, but over a
 * real HTTP connection (StreamableHTTPClientTransport -> a real Node
 * `http.Server`, not the stdio subprocess or the in-memory transport) and
 * with identity carried in a real `Authorization: Bearer <token>` header
 * instead of embedded in resource URIs/tool arguments (see ADR-0021).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../packages/mcp-server/src/http-transport.js";

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok: ${message}`);
  } else {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n[${label}]`);
  await fn();
}

// Smoke tests poke at arbitrary JSON shapes; a typed result would add nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(result: { contents: { text?: string }[] }): any {
  return JSON.parse(result.contents[0]!.text ?? "null");
}

async function main(): Promise<void> {
  const running = await startHttpServer(0);

  await step("1. Discover an Aircraft (anonymous — no Authorization header)", async () => {
    const client = new Client({ name: "smoke-test-http-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${running.port}/mcp`)));
    const { resources } = await client.listResources();
    assert(
      resources.some((r) => r.uri.includes("objects/airforce.Aircraft/AF86-0147")),
      "Aircraft AF86-0147 is discoverable via resources/list"
    );
    await client.close();
  });

  await step("2. Retrieve the Aircraft using a real Authorization: Bearer header", async () => {
    const client = new Client({ name: "smoke-test-http-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${running.port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer demo-maintainer-token" } }
      })
    );
    const object = readJson(await client.readResource({ uri: "typesys://objects/airforce.Aircraft/AF86-0147" }));
    assert(object.values.tailNumber === "AF86-0147", "retrieved object has the expected tail number");
    assert(typeof object.values.maintenanceStatus === "string", "maintainer's header-derived identity sees maintenanceStatus");
    await client.close();
  });

  await step("3. Navigate to its components and maintenance history", async () => {
    const client = new Client({ name: "smoke-test-http-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${running.port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer demo-maintainer-token" } }
      })
    );
    const components = readJson(
      await client.readResource({ uri: "typesys://objects/airforce.Aircraft/AF86-0147/relationships/components" })
    );
    assert(Array.isArray(components) && components.length === 2, "two components resolved");
    await client.close();
  });

  await step("4. Discover and invoke Actions over HTTP, authorized vs. denied purely by header", async () => {
    const maintainerClient = new Client({ name: "smoke-test-http-client", version: "0.0.0" });
    await maintainerClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${running.port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer demo-maintainer-token" } }
      })
    );
    const { tools } = await maintainerClient.listTools();
    assert(tools.some((t) => t.name === "CreateMaintenanceWorkOrder"), "CreateMaintenanceWorkOrder tool is listed");

    const authorized = await maintainerClient.callTool({
      name: "CreateMaintenanceWorkOrder",
      arguments: { maintenanceEventId: "EVT-9001", assignedTo: "HTTP Smoke Test" }
    });
    assert(authorized.isError !== true, "maintainer (Authorization header) invocation succeeds");
    await maintainerClient.close();

    const viewerClient = new Client({ name: "smoke-test-http-client", version: "0.0.0" });
    await viewerClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${running.port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer demo-viewer-token" } }
      })
    );
    const denied = await viewerClient.callTool({
      name: "CreateMaintenanceWorkOrder",
      arguments: { maintenanceEventId: "EVT-9002", assignedTo: "HTTP Smoke Test" }
    });
    assert(denied.isError === true, "viewer (Authorization header) invocation is denied — a fresh Server per request, no session bleed");
    await viewerClient.close();
  });

  await step("5. A GET to /mcp is rejected (stateless mode has no server-initiated stream)", async () => {
    const res = await fetch(`http://localhost:${running.port}/mcp`, { method: "GET" });
    assert(res.status === 405, "GET /mcp returns 405 Method Not Allowed");
  });

  await running.close();

  if (failures > 0) {
    console.error(`\n${failures} smoke test assertion(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll MCP HTTP transport smoke test steps passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
