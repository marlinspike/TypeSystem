/**
 * Adversarial review of ADR-0059 (domain packs). Each `it` asserts the secure
 * or correct behaviour; a failing test is a confirmed finding.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  DEMO_LINEAR_CLASSIFICATION,
  InMemoryRegistryStore,
  SemanticRegistry,
  SemanticRuntime,
  coreManifest,
  emptyBindingRegistry,
  registerDomain,
  type DomainManifest,
  type DomainTypeEntry
} from "@typesys/core";
import { AircraftType, airforceBindingRegistry, airforceManifest, airforcePack, buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { buildPack, checkUpgrade, corePack, installPacks, planInstall, signPack, verifyPack, type PackArchive } from "../src/index.js";

const codes = (ds: readonly { code: string; pack: string; subject?: string }[]) => ds.map((d) => `${d.code} ${d.pack}${d.subject ? ` ${d.subject}` : ""}`).sort();

/** airforce at `version` with Aircraft's schema changed by `schema`, Aircraft itself keeping version 1.0.0. */
function airforceWith(version: string, schema: (s: DomainTypeEntry["schema"]) => DomainTypeEntry["schema"], actions = airforceManifest.actions): PackArchive {
  const manifest: DomainManifest = {
    ...airforceManifest,
    types: airforceManifest.types.map((t) => (t === AircraftType ? { ...t, schema: schema(structuredClone(t.schema)) } : t)),
    actions
  };
  return buildPack({ name: "airforce", version, description: airforcePack.description, requires: { core: "^1.0.0" }, manifests: [manifest] });
}

describe("pressure: checkUpgrade and protections", () => {
  it("does not pass a patch upgrade that strips Aircraft's property policy and SECRET classification as safe", async () => {
    const stripped = airforceWith("1.0.1", (s) => {
      const { "x-policy": _p, "x-provenance": _c, ...rest } = s;
      return { ...rest, "x-policy": { objectPolicy: "airforce.read-aircraft" } };
    });
    const report = await checkUpgrade([corePack, airforcePack], stripped);

    // Show what the upgrade does: after installing it, a CUI viewer reads the maintainer-only and SECRET values.
    const testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await installPacks(registry, [corePack, stripped], { bindings: airforceBindingRegistry });
    const runtime = new SemanticRuntime(registry, [testbed.inMemoryAdapter, testbed.mockRestAdapter], testbed.policyEngine, { classification: DEMO_LINEAR_CLASSIFICATION });
    const before = Object.keys((await testbed.runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.viewer)).values);
    const after = Object.keys((await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.viewer)).values);
    expect(before).not.toContain("deploymentLocation");
    expect(after).toEqual(expect.arrayContaining(["deploymentLocation", "maintenanceStatus"])); // the impact is real

    // Expected: an upgrade that weakens a protection is not reported as a safe patch.
    expect(report.diagnostics.length > 0 || report.changes.some((c) => c.impact !== "compatible")).toBe(true);
  });

  it("does not pass a patch upgrade that loosens an Action's authorization policy as safe", async () => {
    const loosened = airforceWith("1.0.1", (s) => s, airforceManifest.actions!.map((a) => (a.name === "CreateMaintenanceWorkOrder" ? { ...a, authorizationPolicy: "airforce.read-aircraft" } : a)));
    const report = await checkUpgrade([corePack, airforcePack], loosened);
    expect(report.diagnostics.length > 0 || report.changes.length > 0).toBe(true);
  });
});

describe("pressure: install never looks at the target registry", () => {
  /** A pack, from anyone, that names Types it does not own: airforce.Aircraft with no policy and its own source. */
  const hijack = buildPack({
    name: "weather",
    version: "1.0.0",
    description: "Innocent-looking weather pack",
    manifests: [
      {
        domain: "weather",
        dataSources: [{ id: "in-memory-airforce-repo", name: "redirected", kind: "rest", config: { baseUrl: "https://attacker.example" } }],
        types: [
          {
            schema: { $id: "https://typesys.dev/types/airforce/Aircraft/9.0.0", title: "Aircraft", type: "object", properties: { tailNumber: { type: "string" }, deploymentLocation: { type: "string" } } },
            options: { name: "airforce.Aircraft", version: "9.0.0" }
          }
        ]
      }
    ]
  });

  it("refuses a pack that redefines a Type and a data source already in the registry", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registerDomain(registry, coreManifest);
    await registerDomain(registry, airforceManifest);
    const original = await registry.getType("airforce.Aircraft");
    expect(original?.schema["x-policy"]?.propertyPolicies).toBeDefined();

    const plan = await planInstall([hijack], { bindings: emptyBindingRegistry() });
    let refused = false;
    await installPacks(registry, [hijack], { bindings: emptyBindingRegistry() }).catch(() => (refused = true));
    // Each redefinition is named on its own, so no one check stands in for another.
    const against = codes((await planInstall([hijack], { bindings: emptyBindingRegistry(), registry })).diagnostics);
    expect(against).toContain(`conflict ${hijack.name} airforce.Aircraft`);
    expect(against).toContain(`conflict ${hijack.name} in-memory-airforce-repo`);

    const now = await registry.getType("airforce.Aircraft");
    const source = await registry.getDataSource("in-memory-airforce-repo");
    // Expected: refused, and the registry's airforce.Aircraft and its data source untouched.
    expect({ planDiagnostics: plan.diagnostics.length > 0, refused, version: now?.version, policy: now?.schema["x-policy"], source: source?.name }).toEqual({
      planDiagnostics: true,
      refused: true,
      version: "1.0.0",
      policy: original?.schema["x-policy"],
      source: expect.not.stringMatching(/redirected/) as unknown
    });
  });
});

describe("pressure: pre-install validation", () => {
  it("reports two different definitions of one Type inside a single pack", async () => {
    const t = (desc: string, props: Record<string, unknown>): DomainTypeEntry => ({
      schema: { $id: `https://typesys.dev/types/dup/T/${desc}`, title: "T", type: "object", properties: props as never },
      options: { name: "dup.T", version: "1.0.0" }
    });
    const dup = buildPack({ name: "dup", version: "1.0.0", description: "", manifests: [{ domain: "dup", types: [t("a", { visible: { type: "string" } }), t("b", { other: { type: "number" } })] }] });
    const plan = await planInstall([dup], { bindings: emptyBindingRegistry() });
    expect(codes(plan.diagnostics)).toContain("conflict dup dup.T");
  });

  it("returns a diagnostic, not a crash, for a signature whose keyId is an Object.prototype name", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signPack(airforcePack, "constructor", privateKey);
    expect(() => verifyPack(signed, { trustedKeys: { release: publicKey } })).not.toThrow();
  });
});
