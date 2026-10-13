import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildAirforceTestbed, resolveDemoIdentity, type AirforceTestbed } from "@typesys/domain-airforce";
import { createServer } from "../src/server.js";

/** `typesys_list_actions` and `typesys_preview_action` (ADR-0053): an agent asks before it acts, over the same runtime. */
describe("Action discovery and previews over MCP (ADR-0053)", () => {
  let testbed: AirforceTestbed;
  let client: Client;
  let workOrderId: string;

  beforeEach(async () => {
    testbed = await buildAirforceTestbed();
    const { server } = createServer(testbed, resolveDemoIdentity);
    client = new Client({ name: "preview-test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    await client.listTools(); // so the client validates structuredContent against each outputSchema
    const created = await client.callTool({ name: "CreateMaintenanceWorkOrder", arguments: { maintenanceEventId: "EVT-9001", assignedTo: "SSgt Rivera", authToken: "demo-maintainer-token" } });
    workOrderId = (created.structuredContent as { id: string }).id;
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  };

  it("lists what the caller may invoke on one object", async () => {
    const asMaintainer = await call("typesys_list_actions", { type: "airforce.WorkOrder", id: workOrderId, authToken: "demo-maintainer-token" });
    expect(asMaintainer.actions).toEqual([
      { name: "UpdateWorkOrderStatus", description: expect.any(String) as string, authorized: true, instanceScoped: true, sideEffects: "mutates", idempotency: "natural" }
    ]);
    const perType = await call("typesys_list_actions", { type: "airforce.WorkOrder", authToken: "demo-maintainer-token" });
    expect((perType.actions as { authorized: boolean }[])[0]!.authorized).toBe(false);
  });

  it("previews without executing, and the runtime's state is unchanged", async () => {
    const preview = await call("typesys_preview_action", { action: "UpdateWorkOrderStatus", input: { workOrderId, status: "closed" }, authToken: "demo-maintainer-token" });
    expect(preview).toMatchObject({ wouldExecute: true, authorized: true, target: { typeName: "airforce.WorkOrder", objectId: workOrderId } });
    const after = await testbed.runtime.getObject("airforce.WorkOrder", workOrderId, { subjectId: "t", roles: ["maintainer"], attributes: {} });
    expect(after.values.status).toBe("open");

    const asViewer = await call("typesys_preview_action", { action: "UpdateWorkOrderStatus", input: { workOrderId, status: "closed" }, authToken: "demo-viewer-token" });
    expect(asViewer).toMatchObject({ wouldExecute: false, authorized: false, inputValid: null });
  });

  it("answers a bad id argument as a tool error", async () => {
    const result = await client.callTool({ name: "typesys_list_actions", arguments: { type: "airforce.WorkOrder", id: 5, authToken: "demo-maintainer-token" } });
    expect(result.isError).toBe(true);
  });
});
