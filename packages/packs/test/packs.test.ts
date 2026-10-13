import { readFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import {
  DEMO_LINEAR_CLASSIFICATION,
  InMemoryRegistryStore,
  SemanticRegistry,
  SemanticRuntime,
  coreManifest,
  describeModel,
  emptyBindingRegistry,
  type DomainManifest,
  type DomainTypeEntry,
  type Identity
} from "@typesys/core";
import {
  AircraftType,
  airforceBindingRegistry,
  airforceManifest,
  airforcePack,
  airforcePolicyRules,
  buildAirforceTestbed,
  demoIdentities,
  type AirforceTestbed
} from "@typesys/domain-airforce";
import { buildHospitalTestbed, hospitalPack, hospitalPolicyRules } from "@typesys/domain-hospital";
import { PACKS, driftedPacks, packFile } from "../../../scripts/build-packs.js";
import { PackError, buildPack, checkUpgrade, corePack, installPacks, planInstall, signPack, verifyPack, type PackArchive, type PackDiagnostic } from "../src/index.js";

const POLICIES = Object.keys(airforcePolicyRules);
const load = async (p: PackArchive) => JSON.parse(await readFile(packFile(p), "utf8")) as PackArchive;
const codes = (ds: readonly PackDiagnostic[]) => ds.map((d) => `${d.code} ${d.pack}${d.subject ? ` ${d.subject}` : ""}`).sort();

/** The airforce pack with Aircraft changed by `change`, at pack version `version`. */
function airforceVariant(version: string, aircraft: (t: DomainTypeEntry) => DomainTypeEntry): PackArchive {
  const manifest: DomainManifest = { ...airforceManifest, types: airforceManifest.types.map((t) => (t === AircraftType ? aircraft(t) : t)) };
  return buildPack({ name: "airforce", version, description: airforcePack.description, requires: { core: "^1.0.0" }, manifests: [manifest] });
}
const aircraftAt = (version: string, properties: (p: Record<string, unknown>) => Record<string, unknown>) => (t: DomainTypeEntry): DomainTypeEntry => ({
  schema: { ...t.schema, $id: `https://typesys.dev/types/airforce/Aircraft/${version}`, properties: properties({ ...(t.schema.properties as Record<string, unknown>) }) as never },
  options: { ...t.options, version }
});

/** A deployment's own specialization: an F-16 is an Aircraft with a block number. */
const sitePack = buildPack({
  name: "site-f16",
  version: "1.0.0",
  description: "This wing's F-16s.",
  requires: { airforce: "^1.0.0" },
  manifests: [
    {
      domain: "site",
      types: [
        {
          schema: { $id: "https://typesys.dev/types/site/F16/1.0.0", title: "F-16", type: "object", properties: { blockNumber: { type: "integer" } } },
          options: { name: "site.F16", version: "1.0.0", extends: "airforce.Aircraft" }
        }
      ],
      mappings: [{ id: "map-f16", typeName: "site.F16", target: "property", targetName: "*", dataSourceId: "in-memory-airforce-repo", operation: "get", resolutionMode: "live" }]
    }
  ]
});

let testbed: AirforceTestbed;
beforeAll(async () => {
  testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
});

describe("domain packs (ADR-0059)", () => {
  it("the committed archives are exactly what the domains build", async () => {
    expect(await driftedPacks()).toEqual([]);
    expect(PACKS.map((p) => verifyPack(p))).toEqual([[], [], []]);
  });

  it("installed from its files with no network, the airforce domain is the same model and answers every caller the same", async () => {
    const archives = await Promise.all([load(airforcePack), load(corePack)]);
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const lock = await installPacks(registry, archives, {
      bindings: airforceBindingRegistry,
      policies: POLICIES,
      adapters: [testbed.inMemoryAdapter, testbed.mockRestAdapter]
    });
    expect(lock).toEqual([
      { name: "core", version: "1.0.0", digest: corePack.digest },
      { name: "airforce", version: "1.0.0", digest: airforcePack.digest }
    ]);
    expect(await describeModel(registry)).toEqual(await describeModel(testbed.registry));

    const runtime = new SemanticRuntime(registry, [testbed.inMemoryAdapter, testbed.mockRestAdapter], testbed.policyEngine, { classification: DEMO_LINEAR_CLASSIFICATION });
    const reads = (r: SemanticRuntime, who: Identity) => [
      () => r.getObject("airforce.Aircraft", "AF86-0147", who, { includeProvenance: true }),
      () => r.query({ type: "airforce.Aircraft", filter: { property: "needsAttention", operator: "eq", value: true } }, who),
      () => r.listActions("airforce.MaintenanceEvent", who, { objectId: "EVT-9001" }),
      () => r.previewAction("UpdateWorkOrderStatus", { workOrderId: "WO-5001", status: "closed" }, who)
    ];
    const settle = async (f: () => Promise<unknown>) =>
      JSON.stringify(await f().then((ok) => ({ ok }), (err: Error) => ({ refused: err.message })), (k, v: unknown) => (k === "retrievedAt" ? "<t>" : v));
    for (const who of [demoIdentities.maintainer, demoIdentities.viewer, demoIdentities.anonymous]) {
      const [fromPacks, fromCode] = [reads(runtime, who), reads(testbed.runtime, who)];
      for (let i = 0; i < fromPacks.length; i++) expect(await settle(fromPacks[i]!)).toBe(await settle(fromCode[i]!));
    }
  });

  it("installs the hospital domain from its file as the same model", async () => {
    const hospital = await buildHospitalTestbed();
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await installPacks(registry, [await load(hospitalPack), await load(corePack)], { bindings: emptyBindingRegistry(), policies: Object.keys(hospitalPolicyRules) });
    expect(await describeModel(registry)).toEqual(await describeModel(hospital.registry));
  });

  it("refuses a changed pack, and with trusted keys one no trusted key signed", () => {
    const tampered = structuredClone(airforcePack) as { -readonly [K in keyof PackArchive]: PackArchive[K] };
    (tampered.contents.types[0]!.schema.properties as Record<string, unknown>).backdoor = { type: "string" };
    expect(codes(verifyPack(tampered))).toEqual(["digest-mismatch airforce"]);

    // Claiming fewer requirements than the contents have is caught even when the digest is recomputed.
    const lying = { ...airforcePack, requirements: { ...airforcePack.requirements, policies: [] } };
    expect(codes(verifyPack(lying))).toContain("invalid-pack airforce");
    expect(codes(verifyPack({ format: "typesys.pack/0" }))).toContain("invalid-pack (unnamed)");

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const signed = signPack(airforcePack, "wing-release", privateKey);
    expect(signed.digest).toBe(airforcePack.digest);
    expect(verifyPack(signed, { trustedKeys: { "wing-release": publicKey } })).toEqual([]);
    expect(codes(verifyPack(airforcePack, { trustedKeys: { "wing-release": publicKey } }))).toEqual(["untrusted airforce"]);
    expect(codes(verifyPack(signed, { trustedKeys: { "wing-release": other.publicKey } }))).toEqual(["bad-signature airforce wing-release", "untrusted airforce"]);
    expect(codes(verifyPack(signPack(airforcePack, "someone", other.privateKey), { trustedKeys: { "wing-release": publicKey } }))).toEqual(["untrusted airforce"]);
    // A re-signed tampered pack still fails on its digest.
    expect(codes(verifyPack(signPack(tampered, "wing-release", privateKey), { trustedKeys: { "wing-release": publicKey } }))).toEqual(["digest-mismatch airforce"]);
  });

  it("reports everything a deployment is missing at once, and registers nothing", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const attempt = installPacks(registry, [airforcePack], {
      bindings: { computed: { computeReadinessStatus: airforceBindingRegistry.computed.computeReadinessStatus! }, preconditions: {} },
      policies: ["airforce.read-aircraft"],
      adapters: [testbed.inMemoryAdapter]
    });
    await expect(attempt).rejects.toBeInstanceOf(PackError);
    expect(codes(((await attempt.catch((e: unknown) => e)) as PackError).diagnostics)).toEqual([
      "missing-adapter airforce mock-remis-rest",
      "missing-binding airforce computeNeedsAttention",
      "missing-binding airforce maintenanceEventExists",
      "missing-binding airforce workOrderNotClosed",
      "missing-dependency airforce core",
      "unknown-policy airforce airforce.maintainer-only",
      "unknown-policy airforce airforce.work-order-assignee",
      "unresolved-reference airforce core.Asset",
      "unresolved-reference airforce core.Event"
    ]);
    expect(await registry.listTypes()).toEqual([]);
  });

  it("refuses a dependency at the wrong version, a cycle, and two packs defining the same thing", async () => {
    const core2 = buildPack({ name: "core", version: "2.0.0", description: "", manifests: [coreManifest] });
    expect(codes((await planInstall([core2, airforcePack], { bindings: airforceBindingRegistry })).diagnostics)).toEqual(["version-conflict airforce core"]);

    const a = buildPack({ name: "a", version: "1.0.0", description: "", requires: { b: "*" }, manifests: [] });
    const b = buildPack({ name: "b", version: "1.0.0", description: "", requires: { a: "*" }, manifests: [] });
    expect(codes((await planInstall([a, b], { bindings: emptyBindingRegistry() })).diagnostics)).toEqual(["cycle a"]);

    const fork = buildPack({ name: "airforce-fork", version: "1.0.0", description: "", requires: { core: "^1.0.0" }, manifests: [airforceManifest] });
    const clash = codes((await planInstall([corePack, airforcePack, fork], { bindings: airforceBindingRegistry })).diagnostics);
    expect(clash).toContain("conflict airforce-fork airforce.Aircraft");
    expect(clash).toContain("conflict airforce-fork CreateMaintenanceWorkOrder");
    expect(clash).not.toContain("conflict airforce-fork in-memory-airforce-repo");

    expect(codes((await planInstall([airforcePack], { bindings: airforceBindingRegistry, installed: [corePack, airforcePack] })).diagnostics)).toEqual(["conflict airforce"]);
  });

  it("catches what only the registry refuses before anything is registered", async () => {
    const broken = buildPack({
      name: "broken",
      version: "1.0.0",
      description: "",
      requires: { core: "^1.0.0" },
      manifests: [{ domain: "broken", types: [{ schema: { $id: "https://typesys.dev/types/broken/T/1.0.0", title: "T", type: "object", properties: { n: { type: "nonsense" } } }, options: { name: "broken.T", version: "1.0.0" } }] }]
    });
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const failure = (await installPacks(registry, [corePack, broken], { bindings: emptyBindingRegistry() }).catch((e: unknown) => e)) as PackError;
    expect(codes(failure.diagnostics)).toEqual(["registration-failed broken"]);
    expect(await registry.listTypes()).toEqual([]);
  });

  it("is specialized by a pack that extends it, over the deployment's own source", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const lock = await installPacks(registry, [sitePack, airforcePack, corePack], { bindings: airforceBindingRegistry, dataSources: { "in-memory-airforce-repo": { name: "Wing maintenance database" } } });
    expect(lock.map((p) => p.name)).toEqual(["core", "airforce", "site-f16"]);
    const f16 = (await describeModel(registry)).types.find((t) => t.name === "site.F16")!;
    expect(Object.keys(f16.properties)).toEqual(expect.arrayContaining(["tailNumber", "deploymentLocation", "maintenanceStatus", "blockNumber"]));
    expect((await registry.getDataSource("in-memory-airforce-repo"))?.name).toBe("Wing maintenance database");

    // The specialization keeps the Aircraft's protections (ADR-0060): the viewer gets no maintainer-only or SECRET value.
    testbed.inMemoryAdapter.seed("site.F16", [{ objectId: "F16-1", values: { id: "F16-1", name: "Viper", tailNumber: "F16-1", model: "F-16C", maintenanceStatus: "down", deploymentLocation: "Base X", blockNumber: 52 } }]);
    const runtime = new SemanticRuntime(registry, [testbed.inMemoryAdapter, testbed.mockRestAdapter], testbed.policyEngine, { classification: DEMO_LINEAR_CLASSIFICATION });
    const read = async (who: Identity) => Object.keys((await runtime.getObject("site.F16", "F16-1", who)).values).sort();
    expect(await read(demoIdentities.viewer)).toEqual(["blockNumber", "id", "model", "name", "needsAttention", "tailNumber"]);
    expect(await read(demoIdentities.maintainer)).toEqual(expect.arrayContaining(["deploymentLocation", "maintenanceStatus", "readinessStatus"]));
    expect(codes((await planInstall([sitePack], { bindings: airforceBindingRegistry, installed: [corePack] })).diagnostics)).toEqual([
      "missing-dependency site-f16 airforce",
      "unresolved-reference site-f16 airforce.Aircraft",
      "unresolved-reference site-f16 in-memory-airforce-repo"
    ]);
  });

  it("checks an upgrade against the contract diff, the version, and every installed dependent", async () => {
    const installed = [corePack, airforcePack, sitePack];

    const additive = airforceVariant("1.1.0", aircraftAt("1.1.0", (p) => ({ ...p, serviceBranch: { type: "string" } })));
    const ok = await checkUpgrade(installed, additive);
    expect(ok).toMatchObject({ needs: "minor", made: "minor", diagnostics: [] });
    expect(ok.changes).toEqual(expect.arrayContaining([{ impact: "compatible", subject: "airforce.Aircraft.serviceBranch", change: "value added" }]));

    const { deploymentLocation: _gone, ...rest } = AircraftType.schema.properties as Record<string, unknown>;
    const asPatch = await checkUpgrade(installed, airforceVariant("1.0.1", aircraftAt("2.0.0", () => rest)));
    expect(asPatch.needs).toBe("major");
    expect(asPatch.changes).toEqual(expect.arrayContaining([{ impact: "breaking", subject: "site.F16.deploymentLocation", change: "value removed" }]));
    expect(codes(asPatch.diagnostics)).toEqual(["under-versioned airforce 1.0.0 → 1.0.1"]);

    const asMajor = await checkUpgrade(installed, airforceVariant("2.0.0", aircraftAt("2.0.0", () => rest)));
    expect(codes(asMajor.diagnostics)).toEqual(["dependent-broken airforce site-f16"]);

    const unbumpedType = await checkUpgrade(installed, airforceVariant("1.1.0", aircraftAt("1.0.0", (p) => ({ ...p, serviceBranch: { type: "string" } }))));
    expect(codes(unbumpedType.diagnostics)).toEqual(["under-versioned airforce airforce.Aircraft"]);

    expect(codes((await checkUpgrade(installed, airforcePack)).diagnostics)).toEqual(["under-versioned airforce 1.0.0 → 1.0.0"]);
    expect(codes((await checkUpgrade([corePack], hospitalPack)).diagnostics)).toEqual(["missing-dependency hospital"]);
  });

  it("refuses to build a pack that would need code it cannot name", () => {
    const inline = { ...airforceManifest.actions![0]!, preconditions: [{ description: "inline", check: () => Promise.resolve(true) }] };
    expect(() => buildPack({ name: "x", version: "1.0.0", description: "", manifests: [{ domain: "x", types: [], actions: [inline] }] })).toThrow(/needs a bindingId/);
    expect(() => buildPack({ name: "Bad Name", version: "one", description: "", requires: { core: "soon" }, manifests: [] })).toThrow(/3 pack problems/);
  });
});
