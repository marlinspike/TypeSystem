import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClient } from "redis";
import { verifyAuditLog } from "@typesys/core";
import { corePack } from "@typesys/packs";
import { airforcePack } from "@typesys/domain-airforce";
import { airforceDeployment, airforceExtension } from "@typesys/demo-web/deployments";
import { buildHost, overlayEnvironment, emptyEnvironment } from "../src/host.js";
import type { Deployment } from "../src/deployment.js";

const pem = (k: { export(o: object): string | Buffer }, type: "pkcs8" | "spki") => k.export({ type, format: "pem" }).toString();
const k1 = generateKeyPairSync("ed25519");
const k2 = generateKeyPairSync("ed25519");
const packs = [corePack, airforcePack];

describe("P8 deployment state", () => {
  it("P8-L2: a signing key whose public half is not verifyKeys[keyId] boots, and every checkpoint it writes fails verification", async () => {
    const d: Deployment = { ...airforceDeployment, state: { audit: { kind: "memory", signing: { keyId: "k", key: { $secret: "K" } }, verifyKeys: { k: pem(k2.publicKey, "spki") } } } };
    const env = overlayEnvironment({ K: pem(k1.privateKey, "pkcs8") }, emptyEnvironment);
    let booted = false;
    try {
      const host = await buildHost(d, { packs, extensions: [airforceExtension], env });
      booted = true;
      await host.close();
      const v = await verifyAuditLog(host.state.audit, d.state!.audit!.verifyKeys!);
      expect(v.problems.map((p) => p.kind)).toContain("bad-signature");
    } catch {
      /* refused at boot: the desired behaviour */
    }
    expect(booted).toBe(false);
  });

  it.skipIf(!process.env.REDIS_URL)("P8-L3: a boot that fails in an extension's adapters() leaves the state's Redis client (and pools, timers) open", async () => {
    const admin = createClient({ url: process.env.REDIS_URL! });
    await admin.connect();
    const count = async () => (await admin.sendCommand<string>(["CLIENT", "LIST"])).trim().split("\n").length;
    const before = await count();
    const d: Deployment = { ...airforceDeployment, state: { rateLimit: { kind: "redis", url: { $secret: "REDIS" }, capacity: 5, refillPerSecond: 1, keyPrefix: "p8-review:" } } };
    const env = overlayEnvironment({ REDIS: process.env.REDIS_URL!, TYPESYS_AIRFORCE_LATENCY_MS: "not-a-number" }, emptyEnvironment);
    await expect(buildHost(d, { packs, extensions: [airforceExtension], env })).rejects.toThrow(/TYPESYS_AIRFORCE_LATENCY_MS/);
    await new Promise((r) => setTimeout(r, 100));
    const after = await count();
    await admin.close();
    expect(after).toBe(before);
  });
});
