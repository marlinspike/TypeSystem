import { describe, it, expect } from "vitest";
import { ContractUnsatisfiedError, InvalidInputError, runUnderContract } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, releaseReadinessToViewers } from "../src/index.js";

/**
 * Consumer version pinning (ADR-0103): a request made under a contract
 * fails closed on a contracted Type outside its range, and is untouched by
 * every Type the contract does not name.
 */
describe("a consumer's contract", () => {
  const { maintainer, viewer } = demoIdentities;

  it("lets a request through when the model keeps the contract, and changes nothing it returns", async () => {
    const { runtime } = await buildAirforceTestbed();
    const plain = await runtime.getObject("airforce.Aircraft", "AF86-0147", maintainer);
    const pinned = await runUnderContract({ "airforce.Aircraft": "^1.0.0" }, () => runtime.getObject("airforce.Aircraft", "AF86-0147", maintainer));
    expect(pinned).toEqual(plain);
  });

  it("refuses a read, a query, a relationship and an Action on a Type outside the range, before reading a source", async () => {
    const { runtime } = await buildAirforceTestbed();
    const v2 = { "airforce.Aircraft": "^2.0.0", "airforce.WorkOrder": "^2.0.0" };
    await expect(runUnderContract(v2, () => runtime.getObject("airforce.Aircraft", "AF86-0147", maintainer))).rejects.toBeInstanceOf(ContractUnsatisfiedError);
    await expect(runUnderContract(v2, () => runtime.query({ type: "airforce.Aircraft" }, maintainer))).rejects.toBeInstanceOf(ContractUnsatisfiedError);
    await expect(runUnderContract(v2, () => runtime.getRelationship("airforce.Aircraft", "AF86-0147", "components", maintainer))).rejects.toBeInstanceOf(ContractUnsatisfiedError);
    await expect(
      runUnderContract(v2, () => runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9001", assignedTo: "SSgt Rivera" }, maintainer))
    ).rejects.toBeInstanceOf(ContractUnsatisfiedError);
    // Types it does not name are not its business.
    await expect(runUnderContract(v2, () => runtime.query({ type: "airforce.Component", limit: 1 }, maintainer))).resolves.toBeDefined();
  });

  it("refuses an Action whose result is a Type outside the range before the Action runs, leaving nothing written", async () => {
    const { runtime } = await buildAirforceTestbed();
    const pinned = { "airforce.WorkOrder": "^2.0.0" };
    const input = { maintenanceEventId: "EVT-9001", assignedTo: "SSgt Rivera" };
    const workOrders = async () => JSON.stringify(await runtime.query({ type: "airforce.WorkOrder" }, maintainer));
    const before = await workOrders();
    await expect(runUnderContract(pinned, () => runtime.invokeAction("CreateMaintenanceWorkOrder", input, maintainer))).rejects.toBeInstanceOf(ContractUnsatisfiedError);
    await expect(runUnderContract(pinned, () => runtime.previewAction("CreateMaintenanceWorkOrder", input, maintainer))).rejects.toBeInstanceOf(ContractUnsatisfiedError);
    await expect(
      runUnderContract({ "airforce.MaintenanceEvent": "^2.0.0" }, () => runtime.invokeAction("CreateMaintenanceWorkOrder", input, maintainer))
    ).rejects.toBeInstanceOf(ContractUnsatisfiedError);
    expect(await workOrders()).toBe(before);
    // Within the range, the same Action runs.
    await expect(runUnderContract({ "airforce.WorkOrder": "^1.0.0" }, () => runtime.invokeAction("CreateMaintenanceWorkOrder", input, maintainer))).resolves.toBeDefined();
    expect(await workOrders()).not.toBe(before);
  });

  it("names the Type and the range in its refusal, never the version registered", async () => {
    const { runtime } = await buildAirforceTestbed();
    const err = await runUnderContract({ "airforce.Aircraft": "^2.0.0" }, () => runtime.getObject("airforce.Aircraft", "AF86-0147", viewer)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractUnsatisfiedError);
    expect((err as Error).message).toContain("airforce.Aircraft ^2.0.0");
    expect((err as Error).message).not.toContain("1.0.0");
  });

  it("catches the upgrade it exists for: a consumer built on 1.0.x is refused a 1.1.0 Aircraft, one built on ^1.0.0 is not", async () => {
    const { runtime } = await buildAirforceTestbed({ manifest: releaseReadinessToViewers() });
    await expect(runUnderContract({ "airforce.Aircraft": "~1.0.0" }, () => runtime.getObject("airforce.Aircraft", "AF86-0147", maintainer))).rejects.toBeInstanceOf(ContractUnsatisfiedError);
    await expect(runUnderContract({ "airforce.Aircraft": "^1.0.0" }, () => runtime.getObject("airforce.Aircraft", "AF86-0147", maintainer))).resolves.toBeDefined();
  });

  it("describes the model with whether the contract is kept, judged on what the caller may see", async () => {
    const { runtime } = await buildAirforceTestbed();
    expect((await runtime.describeModel(maintainer)).contract).toBeUndefined();
    const kept = await runUnderContract({ "airforce.Aircraft": "^1.0.0" }, () => runtime.describeModel(maintainer));
    expect(kept.contract).toEqual({ satisfied: true, mismatches: [] });
    const broken = await runUnderContract({ "airforce.Aircraft": "^2.0.0", "airforce.Nothing": "^1.0.0" }, () => runtime.describeModel(maintainer, { prefixes: ["airforce.Work"] }));
    expect(broken.contract).toEqual({
      satisfied: false,
      mismatches: [
        { type: "airforce.Aircraft", range: "^2.0.0", version: "1.0.0" },
        { type: "airforce.Nothing", range: "^1.0.0" }
      ]
    });
  });

  it("is refused when it is not a contract", () => {
    expect(() => runUnderContract({ Aircraft: "^1.0.0" }, () => 1)).toThrow(InvalidInputError);
    expect(() => runUnderContract({ "airforce.Aircraft": "one" }, () => 1)).toThrow(InvalidInputError);
  });
});
