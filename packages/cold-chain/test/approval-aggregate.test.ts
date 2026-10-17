import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowEngine, type AnyWorkflow } from "@typesys/workflow";
import { buildColdChainHost, coldChainIdentities as who } from "../src/index.js";

type Host = Awaited<ReturnType<typeof buildColdChainHost>>;

/**
 * P4-04 (4.0 pressure test): an approval that presents an aggregate read
 * shows the approver a total only when reading it as them gives the same
 * total. Contract prices are CONFIDENTIAL: QA is cleared for them and
 * logistics is not, so a sum of them read by QA is not shown to logistics.
 */
const valueReview: AnyWorkflow = {
  name: "coldchain.ValueReview",
  version: "1.0.0",
  startPolicy: "coldchain.dispose",
  inputSchema: { type: "object", properties: { lotId: { type: "string" } }, required: ["lotId"], additionalProperties: false },
  steps: [
    { kind: "read", name: "lot", run: (client, ctx) => client.get("coldchain.Lot" as never, (ctx.input as { lotId: string }).lotId) },
    { kind: "read", name: "exposure", run: async (client) => (await client.aggregate({ type: "coldchain.Lot" as never, aggregations: [{ name: "value", op: "sum", property: "unitCost" }] })).groups },
    { kind: "read", name: "doses", run: async (client) => (await client.aggregate({ type: "coldchain.Lot" as never, aggregations: [{ name: "n", op: "sum", property: "doses" }] })).groups },
    { kind: "approval", name: "signOff", needs: ["lot", "exposure", "doses"], policy: "coldchain.dispose", allowSelfApproval: true, present: (ctx) => ({ lot: ctx.output("lot"), exposure: ctx.output("exposure"), doses: ctx.output("doses") }) }
  ]
};

let host: Host;
let engine: WorkflowEngine;
beforeAll(async () => {
  host = await buildColdChainHost();
  engine = await WorkflowEngine.create({ host, sleep: async () => {} });
  engine.register(valueReview);
});
afterAll(async () => host?.services?.stop());

describe("an approval presenting an aggregate (P4-04)", () => {
  it("does not show an approver a total of values they may not read", async () => {
    const run = await engine.start("coldchain.ValueReview", { lotId: "L-7751" }, who.qa);
    expect(run.status).toBe("waiting-approval");
    await expect(host.runtime.aggregate({ type: "coldchain.Lot", aggregations: [{ name: "value", op: "sum", property: "unitCost" }] }, who.logistics)).rejects.toThrow(/unitCost/);
    const seen = (await engine.pendingApproval(run.runId, who.logistics)).presented as Record<string, unknown>;
    expect(seen.exposure).toBeUndefined();
    expect(seen.lot).not.toHaveProperty("unitCost");
    // A total they would be given themselves is still shown, and so is one to an approver cleared for it.
    const qa = (await engine.pendingApproval(run.runId, who.qa)).presented as Record<string, unknown>;
    expect(seen.doses).toBeDefined();
    expect(seen.doses).toEqual(qa.doses);
    expect(qa.exposure).toBeDefined();
  });
});
