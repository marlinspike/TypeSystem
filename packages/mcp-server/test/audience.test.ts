import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bindAudience, type Audience } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createServer } from "../src/server.js";

/**
 * An MCP server bound to the model behind its agent (ADR-0067): every tool
 * call is decided for the user whose token it carries and for that model.
 */
const MAINTAINER = "demo-maintainer-token";

async function agentFor(audience: Audience) {
  const testbed = await buildAirforceTestbed();
  const { server } = createServer(testbed, bindAudience(resolveDemoIdentity, audience));
  const client = new Client({ name: "audience-test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { ...args, authToken: MAINTAINER } });
    const text = (result.content as { text: string }[])[0]!.text;
    return { isError: result.isError === true, text };
  };
  return { call, testbed };
}

describe("an MCP server bound to its agent's model (ADR-0067)", () => {
  it("the maintainer's agent on the enclave model reads the aircraft without its SECRET location", async () => {
    const { call } = await agentFor(demoAudiences.enclaveModel);
    const read = await call("typesys_get_object", { type: "airforce.Aircraft", id: "AF86-0147" });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("degraded");
    expect(read.text).not.toContain("FOB ALPHA");
  });

  it("the same maintainer's agent on a commercial model reads nothing and invokes nothing", async () => {
    const { call, testbed } = await agentFor(demoAudiences.commercialModel);
    const read = await call("typesys_get_object", { type: "airforce.Aircraft", id: "AF86-0147" });
    expect(read).toMatchObject({ isError: true });
    expect(read.text).toMatch(/Not authorized/);
    const invoke = await call("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9002", assignedTo: "SSgt Rivera" });
    expect(invoke.isError).toBe(true);
    const rows = (await testbed.registry.listAuditEvents({ limit: 100 })).items;
    expect(rows.some((e) => e.decision === "deny" && e.details?.audience === demoAudiences.commercialModel.id)).toBe(true);
  });
});
