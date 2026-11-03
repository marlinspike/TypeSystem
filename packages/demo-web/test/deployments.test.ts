import { describe, it, expect } from "vitest";
import type { Identity, SemanticRuntime } from "@typesys/core";
import { corePack } from "@typesys/packs";
import { buildHost, emptyEnvironment } from "@typesys/host";
import { airforcePack, buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { buildHospitalTestbed, hospitalDemoIdentities, hospitalPack } from "@typesys/domain-hospital";
import { airforceDeployment, airforceExtension, hospitalDeployment, hospitalExtension } from "../src/deployments.js";

/**
 * ADR-0102: the demonstration deployments serve exactly what the testbeds
 * they replace in the image served: the same objects, values, provenance
 * and refusals, for every persona and every Type.
 */

async function everything(runtime: SemanticRuntime, types: readonly string[], who: Identity): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const type of types) {
    try {
      const { items } = await runtime.query({ type, limit: 100 }, who);
      out[type] = items.map((o) => ({ id: o.objectId, values: o.values, provenance: o.provenance?.map((p) => ({ ...p, retrievedAt: undefined })) }));
    } catch (err) {
      out[type] = { refused: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  }
  return out;
}

describe("the demonstration deployments match their testbeds", () => {
  it("airforce: every Type, every persona", async () => {
    const testbed = await buildAirforceTestbed();
    const host = await buildHost(airforceDeployment, { packs: [corePack, airforcePack], extensions: [airforceExtension], env: emptyEnvironment });
    const types = (await testbed.registry.listTypes()).map((t) => t.name).filter((n) => n.startsWith("airforce."));
    expect(types.length).toBeGreaterThanOrEqual(4);
    expect((await host.registry.listTypes()).map((t) => t.name).sort()).toEqual((await testbed.registry.listTypes()).map((t) => t.name).sort());
    for (const who of Object.values(demoIdentities)) expect(await everything(host.runtime, types, who)).toEqual(await everything(testbed.runtime, types, who));
    expect(JSON.stringify(await everything(host.runtime, types, demoIdentities.maintainer))).toContain("AF86-0147");
    await host.close();
  });

  it("hospital: every Type, every persona", async () => {
    const testbed = await buildHospitalTestbed();
    const host = await buildHost(hospitalDeployment, { packs: [corePack, hospitalPack], extensions: [hospitalExtension], env: emptyEnvironment });
    const types = (await testbed.registry.listTypes()).map((t) => t.name).filter((n) => n.startsWith("hospital."));
    expect(types.length).toBe(3);
    const people = [...Object.values(hospitalDemoIdentities), host.personas.admin!];
    for (const who of people) expect(await everything(host.runtime, types, who)).toEqual(await everything(testbed.runtime, types, who));
    expect(JSON.stringify(await everything(host.runtime, types, host.personas.admin!))).toContain("PT-1001");
    await host.close();
  });
});
