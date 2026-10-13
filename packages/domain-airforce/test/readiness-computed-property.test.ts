import { describe, it, expect } from "vitest";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";

describe("Aircraft.readinessStatus (computed property)", () => {
  it("derives readinessStatus live from maintenanceStatus", async () => {
    const { runtime } = await buildAirforceTestbed();

    const degraded = await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.maintainer);
    expect(degraded.values.readinessStatus).toBe("PMC");

    const operational = await runtime.getObject("airforce.Aircraft", "AF86-0212", demoIdentities.maintainer);
    expect(operational.values.readinessStatus).toBe("FMC");
  });

  it("a viewer sees neither maintenanceStatus nor readinessStatus, which maps it one to one (ADR-0052)", async () => {
    const { runtime } = await buildAirforceTestbed();

    const asViewer = await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.viewer);
    expect(asViewer.values.readinessStatus).toBeUndefined();
    expect(asViewer.values.maintenanceStatus).toBeUndefined();
    // needsAttention is released from maintenanceStatus's policy by the domain, explicitly.
    expect(asViewer.values.needsAttention).toBe(true);

    const asMaintainer = await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.maintainer);
    expect(asMaintainer.values.maintenanceStatus).toBe("degraded");
    expect(asMaintainer.values.readinessStatus).toBe("PMC");
  });

  it("getProvenance for a computed property aggregates provenance from its dependsOn sources", async () => {
    const { runtime } = await buildAirforceTestbed();

    const provenance = await runtime.getProvenance(
      "airforce.Aircraft",
      "AF86-0147",
      "readinessStatus",
      demoIdentities.maintainer
    );
    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.propertyPath).toBe("maintenanceStatus");
    expect(provenance[0]?.source.dataSourceId).toBe("in-memory-airforce-repo");
  });
});
