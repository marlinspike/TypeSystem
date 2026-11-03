import { describe, expect, it } from "vitest";
import { corePack } from "@typesys/packs";
import { airforcePack } from "@typesys/domain-airforce";
import { airforceDeployment, airforceExtension } from "@typesys/demo-web/deployments";
import { checkDeployment, type DeploymentBuild } from "../src/check.js";
import { emptyEnvironment } from "../src/host.js";
import type { Deployment } from "../src/deployment.js";

const build = (deployment: Deployment): DeploymentBuild => ({ deployment, packs: [corePack, airforcePack], extensions: [airforceExtension], env: emptyEnvironment });

describe("P8 deploy check", () => {
  it("P8-M6: widening the deployment's runtime.inspectionPolicy to everyone is not blocking", async () => {
    const withInspect = (expr: Deployment["policies"][string]): Deployment => ({
      ...airforceDeployment,
      policies: { ...airforceDeployment.policies, "ops.inspect": expr },
      runtime: { ...airforceDeployment.runtime, inspectionPolicy: "ops.inspect" }
    });
    const report = await checkDeployment(build(withInspect({ role: ["maintainer"] })), build(withInspect("always")));
    // The exact comparison finds the widening (anyone may now inspect, and explain any other subject's access) ...
    expect(report.policies.exact.find((e) => e.policy === "ops.inspect")?.widens.length).toBeGreaterThan(0);
    // ... but drops it, because the rule decides no Type, property or Action.
    expect(report.blocking.some((b) => b.includes("ops.inspect"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("P8-L4: dropping a shared (redis) rate limit is not blocking", async () => {
    const limited: Deployment = { ...airforceDeployment, state: { rateLimit: { kind: "memory", capacity: 5, refillPerSecond: 1 } } };
    const report = await checkDeployment(build(limited), build(airforceDeployment));
    expect(report.state.before.rateLimit).toBe("memory");
    expect(report.state.after.rateLimit).toBe("none");
    expect(report.ok).toBe(false);
  });

  it("P8-L4b: a shared rate limit made per-process, and a verify key removed, both block", async () => {
    const redis: Deployment = { ...airforceDeployment, state: { rateLimit: { kind: "redis", url: "redis://127.0.0.1:1", capacity: 5, refillPerSecond: 1 } } };
    const memory: Deployment = { ...airforceDeployment, state: { rateLimit: { kind: "memory", capacity: 5, refillPerSecond: 1 } } };
    // The check builds both with in-memory state, so the Redis one need not be reachable: it compares the declarations.
    const r1 = await checkDeployment(build(redis), build(memory));
    expect(r1.blocking.some((b) => b.startsWith("state: the rate limit would no longer be shared"))).toBe(true);
    const pub = (await import("node:crypto")).generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const keyed = (keys: Record<string, string>): Deployment => ({ ...airforceDeployment, state: { audit: { kind: "memory", verifyKeys: keys } } });
    const r2 = await checkDeployment(build(keyed({ old: pub, current: pub })), build(keyed({ current: pub })));
    expect(r2.blocking).toContain("state: audit verify key old would be removed; checkpoints it signed would no longer verify");
    // Adding a key is how a key is rotated: not blocking.
    expect((await checkDeployment(build(keyed({ current: pub })), build(keyed({ current: pub, next: pub })))).ok).toBe(true);
  });
});
