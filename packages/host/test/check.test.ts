import { describe, it, expect } from "vitest";
import { buildPack, corePack } from "@typesys/packs";
import { airforceManifest, airforcePack, releaseReadinessToViewers } from "@typesys/domain-airforce";
import { airforceDeployment, airforceExtension } from "@typesys/demo-web/deployments";
import { checkDeployment, renderDeployCheck, type DeploymentBuild } from "../src/check.js";
import { buildHost, emptyEnvironment } from "../src/host.js";
import { DeploymentError, type Deployment } from "../src/deployment.js";
import { deployCommand } from "../src/cli.js";

/** ADR-0104: the upgrade check builds both deployments and blocks what must not roll unreviewed. */

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
