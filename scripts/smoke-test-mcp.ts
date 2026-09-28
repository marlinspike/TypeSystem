#!/usr/bin/env -S npx tsx
/**
 * Spawns the real MCP server over a real stdio subprocess (not the
 * in-memory transport used by packages/mcp-server/test/mcp-contract.test.ts)
 * and runs the exact 7-step discovery -> action script from
 * docs/initial_prompt.md end-to-end. Requires no external infrastructure.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, "../packages/mcp-server/src/bin.ts");
// Invoke the resolved tsx binary directly, not via `npx` — npx can emit its
// own diagnostic text on stdout, which would corrupt the JSON-RPC stream.
const tsxBin = path.resolve(__dirname, "../node_modules/.bin/tsx");

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
  const transport = new StdioClientTransport({ command: tsxBin, args: [serverEntry] });
  const client = new Client({ name: "smoke-test-client", version: "0.0.0" });
  await client.connect(transport);

  await step("1. Discover an Aircraft", async () => {
    const { resources } = await client.listResources();
    assert(
      resources.some((r) => r.uri.includes("objects/airforce.Aircraft/AF86-0147")),
      "Aircraft AF86-0147 is discoverable via resources/list"
    );
  });

  await step("2. Inspect its semantic definition", async () => {
    const doc = readJson(await client.readResource({ uri: "typesys://types/airforce.Aircraft" }));
    assert(doc.relationships.some((r: { name: string }) => r.name === "components"), "Aircraft declares a components relationship");
    assert(doc.relationships.some((r: { name: string }) => r.name === "maintenance"), "Aircraft declares a maintenance relationship");
    assert(doc.computedPropertyNames.includes("readinessStatus"), "Aircraft declares the readinessStatus computed property");
  });

  await step("3. Retrieve the Aircraft", async () => {
    const object = readJson(
      await client.readResource({ uri: "typesys://objects/airforce.Aircraft/AF86-0147?token=demo-maintainer-token" })
    );
    assert(object.values.tailNumber === "AF86-0147", "retrieved object has the expected tail number");
    assert(typeof object.values.readinessStatus === "string", "retrieved object includes the computed readinessStatus");
  });

  await step("4. Navigate to its components and maintenance history", async () => {
    const components = readJson(
      await client.readResource({ uri: "typesys://objects/airforce.Aircraft/AF86-0147/relationships/components?token=demo-maintainer-token" })
    );
    assert(Array.isArray(components) && components.length === 2, "two components resolved");

    const maintenance = readJson(
      await client.readResource({ uri: "typesys://objects/airforce.Aircraft/AF86-0147/relationships/maintenance?token=demo-maintainer-token" })
    );
    assert(Array.isArray(maintenance) && maintenance.length === 2, "two maintenance events resolved");
  });

  await step("5. Understand provenance for a resolved property", async () => {
    const provenance = readJson(
      await client.readResource({
        uri: "typesys://objects/airforce.Aircraft/AF86-0147/provenance/maintenanceStatus?token=demo-maintainer-token"
      })
    );
    assert(provenance[0]?.source?.system === "airforce-repo", "provenance names the contributing source system");
  });

  await step("6. Discover available Actions", async () => {
    const { tools } = await client.listTools();
    assert(tools.some((t) => t.name === "CreateMaintenanceWorkOrder"), "CreateMaintenanceWorkOrder tool is listed");
    assert(tools.some((t) => t.name === "query"), "generic query tool is listed");
  });

  await step("7. Invoke an authorized test Action, and confirm an unauthorized caller is denied", async () => {
    const authorized = await client.callTool({
      name: "CreateMaintenanceWorkOrder",
      arguments: { maintenanceEventId: "EVT-9001", assignedTo: "Smoke Test", authToken: "demo-maintainer-token" }
    });
    assert(authorized.isError !== true, "authorized maintainer invocation succeeds");

    const denied = await client.callTool({
      name: "CreateMaintenanceWorkOrder",
      arguments: { maintenanceEventId: "EVT-9002", assignedTo: "Smoke Test", authToken: "demo-viewer-token" }
    });
    assert(denied.isError === true, "unauthorized viewer invocation is denied on the very next call");
  });

  await client.close();

  if (failures > 0) {
    console.error(`\n${failures} smoke test assertion(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll MCP smoke test steps passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
