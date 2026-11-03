import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { buildPack, corePack } from "@typesys/packs";
import { airforceManifest, airforcePack, releaseReadinessToViewers } from "@typesys/domain-airforce";
import { airforceDeployment, airforceExtension } from "@typesys/demo-web/deployments";
import { checkDeployment, renderDeployCheck, type DeploymentBuild } from "../src/check.js";
import { buildHost, emptyEnvironment } from "../src/host.js";
import { DeploymentError, type Deployment } from "../src/deployment.js";
import { deployCommand } from "../src/cli.js";

/** ADR-0104: the upgrade check builds both deployments and blocks what must not roll unreviewed. */

const PUBLIC = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

const current: DeploymentBuild = { deployment: airforceDeployment, packs: [corePack, airforcePack], extensions: [airforceExtension], env: emptyEnvironment };

// The change-impact demonstration's proposal (ADR-0093), shipped as a new pack version: it releases readinessStatus to every reader.
const airforce11 = buildPack({ ...airforcePackSpec(), version: "1.1.0", manifests: [releaseReadinessToViewers(airforceManifest)] });
function airforcePackSpec() {
  return { name: "airforce", version: "1.0.0", description: airforcePack.description, requires: { core: "^1.0.0" }, manifests: [airforceManifest] };
}
const withPack11 = (d: Deployment = airforceDeployment): Deployment => ({ ...d, packs: [d.packs[0]!, { name: "airforce", version: "1.1.0", digest: airforce11.digest }] });
const next = (deployment: Deployment, packs = current.packs): DeploymentBuild => ({ ...current, deployment, packs });

describe("checkDeployment (ADR-0104)", () => {
  it("finds nothing between a deployment and itself", async () => {
    const report = await checkDeployment(current, current);
    expect(report.ok).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.before.build).toBe(report.after.build);
    expect(report.impact.items).toEqual([]);
    expect(renderDeployCheck(report)).toContain("OK: nothing blocks this upgrade.");
  });

  it("blocks a policy that now admits a persona it refused, and shows what they now read", async () => {
    const widened: Deployment = { ...airforceDeployment, policies: { ...airforceDeployment.policies, "airforce.maintainer-only": { role: ["maintainer", "viewer", "ai-enclave"] } } };
    const report = await checkDeployment(current, next(widened));
    expect(report.ok).toBe(false);
    expect(report.policies.changed).toEqual(["airforce.maintainer-only"]);
    expect(report.policies.decisions.some((d) => d.policy === "airforce.maintainer-only" && d.as === "viewer" && d.before === false && d.after === true)).toBe(true);
    expect(report.blocking.some((b) => b.startsWith("policy airforce.maintainer-only now admits viewer"))).toBe(true);
    // The viewer's read of an Aircraft now returns the maintainer-only values: observed, not only predicted.
    expect(report.impact.exposures.some((e) => e.as === "viewer")).toBe(true);
    expect(report.blocking.some((b) => b.startsWith("exposure: viewer"))).toBe(true);
  });

  it("blocks a rule widened to a role no persona holds: found exactly, not by sampling (ADR-0109)", async () => {
    const widened: Deployment = { ...airforceDeployment, policies: { ...airforceDeployment.policies, "airforce.maintainer-only": { role: ["maintainer", "ai-enclave", "contractor"] } } };
    const report = await checkDeployment(current, next(widened));
    // No persona is a contractor, so no persona's decision or read changes.
    expect(report.policies.decisions).toEqual([]);
    expect(report.impact.exposures).toEqual([]);
    const exact = report.policies.exact.find((e) => e.policy === "airforce.maintainer-only")!;
    expect(exact.widens).toEqual(["a subject with role contractor, on any object and in lists"]);
    expect(exact.decides.length).toBeGreaterThan(0);
    expect(report.blocking.some((b) => b.startsWith("widens: policy airforce.maintainer-only") && b.includes("role contractor"))).toBe(true);
    expect(report.ok).toBe(false);
    expect(renderDeployCheck(report)).toContain("[widens, exact] a subject with role contractor");
  });

  it("blocks a rule change too large to compare exactly, rather than passing it unproven (ADR-0109)", async () => {
    // 13 two-way choices in a row: 8,192 conjunctions, past the comparison's bound.
    const huge = { allOf: Array.from({ length: 13 }, (_, i) => ({ anyOf: [{ role: [`a${i}`] }, { role: [`b${i}`] }] })) };
    const changed: Deployment = { ...airforceDeployment, policies: { ...airforceDeployment.policies, "airforce.maintainer-only": huge } };
    const report = await checkDeployment(current, next(changed));
    expect(report.policies.exact.find((e) => e.policy === "airforce.maintainer-only")).toMatchObject({ tooLarge: true });
    expect(report.blocking.some((b) => b.startsWith("unverified: policy airforce.maintainer-only"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("blocks giving up a kept, signed audit trail (ADR-0106)", async () => {
    const kept: Deployment = { ...airforceDeployment, state: { audit: { kind: "postgres", url: { $secret: "DATABASE_URL" }, signing: { keyId: "k", key: { $secret: "K" } }, verifyKeys: { k: PUBLIC } } } };
    const report = await checkDeployment(next(kept), current);
    expect(report.blocking).toContain("state: the audit trail would no longer be kept: state.audit was postgres");
    expect(report.blocking).toContain("state: audit checkpoints would no longer be signed");
    expect(report.state).toEqual({ before: { audit: "postgres", signed: "yes", workflows: "memory", cache: "none", rateLimit: "none" }, after: { audit: "memory", signed: "no", workflows: "memory", cache: "none", rateLimit: "none" } });
    // The check built the kept deployment without reaching its database: it writes nothing anywhere.
    expect(report.settings).toContain("state");
  });

  it("does not block a policy that only narrows, and lists it for review", async () => {
    const narrowed: Deployment = { ...airforceDeployment, policies: { ...airforceDeployment.policies, "airforce.read-aircraft": { role: ["maintainer", "ai-enclave"] } } };
    const report = await checkDeployment(current, next(narrowed));
    expect(report.policies.changed).toEqual(["airforce.read-aircraft"]);
    expect(report.blocking.filter((b) => !b.startsWith("exposure"))).toEqual([]);
    expect(report.impact.exposures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("sees what a new pack version releases, though no policy changed", async () => {
    const report = await checkDeployment(current, next(withPack11(), [corePack, airforce11]));
    expect(report.packs.changed).toEqual(["airforce: 1.0.0 → 1.1.0"]);
    expect(report.policies.changed).toEqual([]);
    expect(report.impact.exposures.some((e) => e.as === "viewer" && /readinessStatus/.test(`${e.subject} ${e.change}`))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("blocks a build that breaks a consumer's contract, and the host will not start one that breaks a declared consumer", async () => {
    const pinned = { name: "squadron-board", contract: { "airforce.Aircraft": "~1.0.0" } };
    const report = await checkDeployment(current, next(withPack11(), [corePack, airforce11]), { consumers: [pinned] });
    expect(report.consumers).toEqual([{ name: "squadron-board", satisfied: false, mismatches: [{ type: "airforce.Aircraft", range: "~1.0.0", version: "1.1.0" }] }]);
    expect(report.blocking[0]).toBe("consumer squadron-board: the new build does not keep its contract (airforce.Aircraft ~1.0.0, now 1.1.0)");
    const declared: Deployment = { ...withPack11(), consumers: [pinned] };
    await expect(buildHost(declared, { packs: [corePack, airforce11], extensions: [airforceExtension], env: emptyEnvironment })).rejects.toThrow(DeploymentError);
    await expect(buildHost(declared, { packs: [corePack, airforce11], extensions: [airforceExtension], env: emptyEnvironment })).rejects.toThrow("consumers: squadron-board needs airforce.Aircraft ~1.0.0, this build has 1.1.0");
  });

  it("compares the queries a consumer depends on, as every persona, without their values", async () => {
    const widened: Deployment = { ...airforceDeployment, policies: { ...airforceDeployment.policies, "airforce.maintainer-only": { role: ["maintainer", "viewer", "ai-enclave"] } } };
    const report = await checkDeployment(current, next(widened), { queries: [{ type: "airforce.Aircraft", limit: 5 }], personas: ["viewer", "maintainer"] });
    const viewer = report.queries.find((q) => q.as === "viewer")!;
    expect(viewer.effect).toBe("widens");
    expect(viewer.after.values!.length).toBeGreaterThan(viewer.before.values!.length);
    expect(JSON.stringify(report.queries)).not.toContain("AF86-0147");
    expect(report.queries.some((q) => q.as === "maintainer")).toBe(false);
  });
});

describe("typesys deploy", () => {
  it("builds a deployment file and prints its build id", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (s: string) => void lines.push(s);
    try {
      expect(await deployCommand(["build", "deployments/airforce.deployment.json", "--json"])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(lines[0]!) as unknown).toMatchObject({ ok: true, deployment: "airforce", build: expect.stringMatching(/^sha256:/) as unknown });
  });

  it("blocks the shipped widening example and lets the narrowing one through, as the README shows", async () => {
    const quiet = { log: console.log, error: console.error };
    const out: string[] = [];
    console.log = (s: string) => void out.push(s);
    try {
      const run = (file: string) => deployCommand(["check", "deployments/airforce.deployment.json", `examples/upgrades/${file}`, "--packs-dir", "packs", "--json"]);
      expect(await run("airforce-viewers-read-maintenance.deployment.json")).toBe(1);
      const blocked = JSON.parse(out[0]!) as { blocking: string[] };
      expect(blocked.blocking).toContain("policy airforce.maintainer-only now admits viewer (on airforce.Aircraft, airforce.MaintenanceEvent)");
      expect(blocked.blocking).toContain("exposure: viewer reads airforce.Aircraft.maintenanceStatus on airforce.Aircraft/AF86-0147 (now returned to viewer, was withheld)");
      expect(await run("airforce-viewers-lose-aircraft.deployment.json")).toBe(0);
      expect((JSON.parse(out[1]!) as { ok: boolean; policies: { changed: string[] } }).policies.changed).toEqual(["airforce.read-aircraft"]);
      // A refactor no persona notices: only the exact comparison blocks it (ADR-0109).
      expect(await run("airforce-assignee-refactor.deployment.json")).toBe(1);
      const refactor = JSON.parse(out[2]!) as { blocking: string[] };
      expect(refactor.blocking).toEqual([
        "widens: policy airforce.work-order-assignee (deciding UpdateWorkOrderStatus) now admits a subject with no role and a displayName, on an object whose assignedTo equals the subject's displayName"
      ]);
    } finally {
      Object.assign(console, quiet);
    }
  });

  it("checks one file against another, and refuses what is not a contract", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => void out.push(s);
    try {
      expect(await deployCommand(["check", "deployments/airforce.deployment.json", "deployments/airforce.deployment.json", "--json"])).toBe(0);
      expect(JSON.parse(out[0]!) as unknown).toMatchObject({ format: "typesys.deploy-check/1", ok: true });
      expect(await deployCommand(["check", "deployments/airforce.deployment.json", "deployments/airforce.deployment.json", "--consumer", "package.json", "--json"])).toBe(1);
      expect((JSON.parse(out[1]!) as { problems: string[] }).problems[0]).toContain("not a typesys.consumer/1 contract");
      expect(await deployCommand(["check", "a.json", "--object", "nope"])).toBe(2);
    } finally {
      console.log = log;
    }
  });
});
