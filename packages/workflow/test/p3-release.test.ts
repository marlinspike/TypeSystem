import { describe, it, expect } from "vitest";
import { AuthorizationError, withAudience } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel } from "../src/index.js";

/**
 * Pressure test 3 of ADR-0067 in the workflow engine. Amended after review
 * M8: "A caller reading for an audience is told only `Refused while reading
 * for <audience>`, whatever was refused and why." The runtime's refusals
 * hold this; the engine's own refusals (decided by `decideForIdentity`) do
 * not.
 */
const { maintainer, viewer } = demoIdentities;
const { commercialModel } = demoAudiences;

async function startRefusal(who: typeof maintainer): Promise<string | undefined> {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const engine = await WorkflowEngine.create({ host: tb, model: scriptedModel({}, "enclave", demoAudiences.enclaveModel) });
  engine.register(groundForRepair);
  try {
    await engine.start("airforce.GroundForRepair", { aircraftId: "AF86-0147", assignTo: "x" }, withAudience(who, commercialModel));
    return "started";
  } catch (err) {
    if (!(err instanceof AuthorizationError)) throw err;
    return err.reason;
  }
}

describe("p3: workflow refusals to an audience-bound caller (ADR-0067 M8)", () => {
  it("P3-RL3: starting a workflow tells a commercial-model agent the same thing whoever its user is, and not why", async () => {
    const forMaintainer = await startRefusal(maintainer);
    const forViewer = await startRefusal(viewer);
    // Observed: "Not releasable to model:commercial-api/general: Requires one of roles [maintainer, ai-enclave], subject has []"
    // for the maintainer, and "Requires one of roles [maintainer, ai-enclave], subject has [viewer]" for the viewer.
    expect(forMaintainer).toBe(forViewer);
    expect(forMaintainer).toBe(`Refused while reading for ${commercialModel.id}`);
  });
});
