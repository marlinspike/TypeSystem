import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryRegistryStore, SemanticRegistry } from "@typesys/core";
import { airforceBindingRegistry, airforcePack, airforcePolicyRules } from "@typesys/domain-airforce";
import { hospitalPack, hospitalPolicyRules } from "@typesys/domain-hospital";
import { emptyBindingRegistry } from "@typesys/core";
import { corePack, installPacks, signPack, verifyPack, type PackArchive } from "../src/index.js";

/** Adversarial review of ADR-0069. Each test asserts the secure behavior. */
const wing = generateKeyPairSync("ed25519");
const depot = generateKeyPairSync("ed25519");
const REVOKED = { "wing-2025": { reason: "key material exposed" } };
const options = { bindings: airforceBindingRegistry, policies: Object.keys(airforcePolicyRules) };
const auditRows = async (registry: SemanticRegistry) => (await registry.listAuditEvents({ limit: 100 })).items.filter((e) => e.action === "pack.install");

describe("ADR-0069 adversarial", () => {
  it("a co-signed pack is still refused after the revoked key's holder strips (or renames) its own signature", () => {
    const both = signPack(signPack(airforcePack, "wing-2025", wing.privateKey), "depot", depot.privateKey);
    const trustedKeys = { "wing-2025": wing.publicKey, depot: depot.publicKey };
    // Sanity: as delivered, it is refused.
    expect(verifyPack(both, { trustedKeys, revokedKeys: REVOKED }).map((d) => d.code)).toContain("revoked");
    // The holder of the revoked key drops its signature: digest, contents and the depot signature are unchanged.
    const stripped: PackArchive = { ...both, signatures: both.signatures!.filter((s) => s.keyId !== "wing-2025") };
    expect(stripped.digest).toBe(both.digest);
    const renamed: PackArchive = { ...both, signatures: both.signatures!.map((s) => (s.keyId === "wing-2025" ? { ...s, keyId: "wing-2025 " } : s)) };
    // ADR-0069: "Co-signing no longer lets a good key launder a pack a revoked key touched".
    expect(verifyPack(stripped, { trustedKeys, revokedKeys: REVOKED }).map((d) => d.code)).toContain("revoked");
    expect(verifyPack(renamed, { trustedKeys, revokedKeys: REVOKED }).map((d) => d.code)).toContain("revoked");
  });

  it("revoking a key id revokes the key: the same public key trusted under another id does not verify", () => {
    // Key rotation leaves the same key listed under an old and a new id; the deployment revokes the key by one id.
    const trustedKeys = { "wing-2025": wing.publicKey, "wing-2025-ci": wing.publicKey };
    const forged = signPack(airforcePack, "wing-2025-ci", wing.privateKey); // signed by the compromised private key
    expect(verifyPack(forged, { trustedKeys, revokedKeys: REVOKED }).map((d) => d.code)).toContain("revoked");
  });

  it("an install while a revoked pack is in the registry is refused even when the caller leaves it out of `installed`", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const wingAirforce = signPack(airforcePack, "wing-2025", wing.privateKey);
    await installPacks(registry, [corePack, wingAirforce], options);
    // The key is revoked afterwards; the next install names only the dependency it needs.
    const next = installPacks(registry, [hospitalPack], {
      bindings: emptyBindingRegistry(),
      policies: Object.keys(hospitalPolicyRules),
      installed: [corePack],
      revokedKeys: REVOKED
    });
    await expect(next).rejects.toThrow();
  });

  it("installPacks writes a pack.install audit row even when the offered list is malformed", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await expect(installPacks(registry, [null as unknown as PackArchive], options)).rejects.toThrow();
    expect(await auditRows(registry)).toHaveLength(1);
  });

  it("installPacks writes a pack.install audit row when an installed entry is malformed", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await expect(installPacks(registry, [corePack], { ...options, installed: [null as unknown as PackArchive] })).rejects.toThrow();
    expect(await auditRows(registry)).toHaveLength(1);
  });

  it("installPacks audits an install that fails while registering (packs partially registered)", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    // A registry whose store fails on the second Type write, after the plan passed.
    let writes = 0;
    const orig = registry.registerType.bind(registry);
    (registry as unknown as { registerType: typeof orig }).registerType = (async (...args: Parameters<typeof orig>) => {
      if (++writes === 2) throw new Error("store unavailable");
      return orig(...args);
    });
    await expect(installPacks(registry, [corePack], options)).rejects.toThrow("store unavailable");
    expect((await registry.listTypes()).length).toBeGreaterThan(0); // something was registered
    expect(await auditRows(registry)).toHaveLength(1);
  });
});
