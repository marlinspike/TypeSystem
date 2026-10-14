import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryRegistryStore, SemanticRegistry } from "@typesys/core";
import { airforceBindingRegistry, airforcePack, airforcePolicyRules } from "@typesys/domain-airforce";
import { PackError, corePack, installPacks, planInstall, signPack, verifyPack, type PackArchive, type PackDiagnostic } from "../src/index.js";

/**
 * Revoking a signing key or a pack build (ADR-0069). A deployment that
 * learns a key was compromised, or a release was defective, must be able to
 * refuse what it signed, including what it already installed, and see every
 * attempt in the audit trail.
 */
const codes = (ds: readonly PackDiagnostic[]) => ds.map((d) => `${d.code} ${d.pack}${d.subject ? ` ${d.subject}` : ""}`).sort();
const wing = generateKeyPairSync("ed25519");
const depot = generateKeyPairSync("ed25519");
const REVOKED = { "wing-2025": { revokedAt: "2026-10-01T00:00:00Z", reason: "key material exposed" } };
const signedByWing = (p: PackArchive) => signPack(p, "wing-2025", wing.privateKey);
const options = { bindings: airforceBindingRegistry, policies: Object.keys(airforcePolicyRules) };

async function auditRows(registry: SemanticRegistry) {
  return (await registry.listAuditEvents({ limit: 100 })).items.filter((e) => e.action === "pack.install");
}

describe("pack trust revocation (ADR-0069)", () => {
  it("refuses a pack a revoked key signed, though that key is still listed as trusted", () => {
    const pack = signedByWing(airforcePack);
    expect(verifyPack(pack, { trustedKeys: { "wing-2025": wing.publicKey } })).toEqual([]);
    const found = verifyPack(pack, { trustedKeys: { "wing-2025": wing.publicKey }, revokedKeys: REVOKED });
    expect(codes(found)).toEqual(["revoked airforce wing-2025", "untrusted airforce"]);
    expect(found.find((d) => d.code === "revoked")?.message).toBe('Signed by "wing-2025", a key revoked on 2026-10-01T00:00:00Z: key material exposed');
  });

  it("refuses it when a trusted, unrevoked key also signed it: the revoked key's holder handled the pack", () => {
    const both = signPack(signedByWing(airforcePack), "depot", depot.privateKey);
    expect(codes(verifyPack(both, { trustedKeys: { "wing-2025": wing.publicKey, depot: depot.publicKey }, revokedKeys: REVOKED }))).toEqual(["revoked airforce wing-2025"]);
  });

  it("refuses it with no trust store at all, and when the revoked signature does not even verify", () => {
    expect(codes(verifyPack(signedByWing(airforcePack), { revokedKeys: REVOKED }))).toEqual(["revoked airforce wing-2025"]);
    const forged: PackArchive = { ...airforcePack, signatures: [{ keyId: "wing-2025", algorithm: "ed25519", value: "AAAA" }] };
    expect(codes(verifyPack(forged, { revokedKeys: REVOKED }))).toEqual(["revoked airforce wing-2025"]);
  });

  it("refuses a withdrawn build by digest, signed or not, and nothing else", () => {
    const withdrawn = { [airforcePack.digest]: { reason: "defective release" } };
    expect(codes(verifyPack(airforcePack, { revokedDigests: withdrawn }))).toEqual([`revoked airforce ${airforcePack.digest}`]);
    expect(codes(verifyPack(signPack(airforcePack, "depot", depot.privateKey), { trustedKeys: { depot: depot.publicKey }, revokedDigests: withdrawn }))).toEqual([`revoked airforce ${airforcePack.digest}`]);
    expect(verifyPack(corePack, { revokedDigests: withdrawn })).toEqual([]);
  });

  it("matches only a key id the deployment revoked, never one inherited from Object", () => {
    for (const keyId of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const pack = signPack(airforcePack, keyId, depot.privateKey);
      expect(verifyPack(pack, { revokedKeys: {}, revokedDigests: {} }), keyId).toEqual([]);
    }
  });

  it("an install of a revoked pack registers nothing and is audited as refused, with who tried and every reason", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const attempt = installPacks(registry, [signedByWing(airforcePack), corePack], { ...options, revokedKeys: REVOKED, actor: "ops-engineer-7" });
    await expect(attempt).rejects.toBeInstanceOf(PackError);
    expect(await registry.listTypes()).toEqual([]);
    const [row] = await auditRows(registry);
    expect(row).toMatchObject({
      subjectId: "ops-engineer-7",
      decision: "deny",
      reason: "revoked",
      details: {
        packs: [
          { name: "airforce", digest: airforcePack.digest, signedBy: ["wing-2025"] },
          { name: "core", digest: corePack.digest, signedBy: [] }
        ],
        diagnostics: [{ code: "revoked", pack: "airforce", subject: "wing-2025" }]
      }
    });
  });

  it("an accepted install is audited too, with its signers and order", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const signed = [signPack(airforcePack, "depot", depot.privateKey), signPack(corePack, "depot", depot.privateKey)];
    await installPacks(registry, signed, { ...options, trustedKeys: { depot: depot.publicKey }, revokedKeys: REVOKED });
    expect(await auditRows(registry)).toMatchObject([{ subjectId: "system", decision: "allow", details: { signed: true, order: ["core", "airforce"], packs: [{ signedBy: ["depot"] }, { signedBy: ["depot"] }] } }]);
  });

  it("an installed pack whose key is revoked afterwards blocks every later install until it is replaced", async () => {
    const installed = [corePack, signedByWing(airforcePack)];
    const site: PackArchive = { ...corePack, name: "site" };
    const plan = await planInstall([site], { ...options, installed, revokedKeys: REVOKED });
    expect(codes(plan.diagnostics)).toContain("revoked airforce wing-2025");
    expect(plan.order).toEqual([]);
  });
});
