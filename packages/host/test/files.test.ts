import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { corePack } from "@typesys/packs";
import { airforcePack } from "@typesys/domain-airforce";
import { airforceDeployment, airforceExtension } from "@typesys/demo-web/deployments";
import { DEPLOYMENTS, deploymentFile, driftedDeployments } from "../../../scripts/build-deployments.js";
import { loadDeployment, loadExtensions } from "../src/load.js";
import { buildHost, emptyEnvironment } from "../src/host.js";
import { hostFromFile, serve } from "../src/serve.js";
import { DeploymentError, validateDeployment } from "../src/deployment.js";

/** ADR-0102: the deployment files in deployments/ are the packages' deployments, and the generic server runs them. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const airforceFile = path.join(root, "deployments/airforce.deployment.json");

describe("the shipped deployment files", () => {
  it("match the deployments their packages export (npm run deployments -- --check)", async () => {
    expect(await driftedDeployments()).toEqual([]);
    expect(DEPLOYMENTS.map((d) => path.basename(deploymentFile(d)))).toEqual([
      "airforce.deployment.json",
      "airforce-durable.deployment.json",
      "hospital.deployment.json",
      "cold-chain.deployment.json",
      "cold-chain-recalls.deployment.json",
      "sortie-readiness.deployment.json"
    ]);
    for (const d of DEPLOYMENTS) expect(validateDeployment(d)).toEqual([]);
  });

  it("a file and the deployment in code build to the same build id", async () => {
    const fromFile = await hostFromFile(airforceFile);
    const inProcess = await buildHost(airforceDeployment, { packs: [corePack, airforcePack], extensions: [airforceExtension], env: emptyEnvironment });
    expect(fromFile.build).toBe(inProcess.build);
    await Promise.all([fromFile.close(), inProcess.close()]);
  });

  it("finds each pack beside the deployment, or in TYPESYS_PACKS_DIR, and names what it cannot find", async () => {
    const { packs } = await loadDeployment(airforceFile);
    expect(packs.map((p) => p.digest)).toEqual([corePack.digest, airforcePack.digest]);
    const dir = mkdtempSync(path.join(tmpdir(), "deploy-"));
    try {
      writeFileSync(path.join(dir, "d.json"), JSON.stringify(airforceDeployment));
      await expect(loadDeployment(path.join(dir, "d.json"))).rejects.toThrow("pack core@1.0.0: not found");
      expect((await loadDeployment(path.join(dir, "d.json"), { packsDir: path.join(root, "packs") })).packs).toHaveLength(2);
      writeFileSync(path.join(dir, "bad.json"), "{");
      await expect(loadDeployment(path.join(dir, "bad.json"))).rejects.toThrow(DeploymentError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadExtensions", () => {
  const withExtensions = (extensions: string[]) => ({ ...airforceDeployment, extensions });

  it("imports an extension by its package specifier", async () => {
    const [ext] = await loadExtensions(airforceDeployment);
    expect(ext).toBe(airforceExtension);
  });

  it("refuses a path, and a module whose export is not the extension it names", async () => {
    for (const p of ["./evil.js", "/tmp/evil.js", "../x", "@scope/pkg/../../etc", "file:///tmp/x.js"])
      await expect(loadExtensions(withExtensions([p]), () => Promise.reject(new Error("imported")))).rejects.toThrow("not a path");
    await expect(loadExtensions(withExtensions(["@x/y"]), () => Promise.resolve({ default: { name: "@x/z" } }))).rejects.toThrow('must be an extension named "@x/y"');
    expect(await loadExtensions(withExtensions(["@x/y"]), () => Promise.resolve({ default: () => ({ name: "@x/y" }) }))).toEqual([{ name: "@x/y" }]);
  });
});

describe("the generic server", () => {
  it("serves a deployment file over HTTP: its build, and governed reads as each persona", async () => {
    const server = await serve({ file: airforceFile, port: 0 });
    try {
      const at = (p: string, token?: string) => fetch(`http://localhost:${server.port}${p}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
      expect(await (await at("/version")).json()).toEqual({
        deployment: "airforce",
        build: server.host.build,
        packs: ["core@1.0.0", "airforce@1.0.0"],
        state: { audit: "memory", workflows: "memory", cache: "none", rateLimit: "none" },
        auditChain: server.host.state.audit.chain,
        applications: []
      });
      expect((await at("/healthz")).status).toBe(200);
      const read = async (token?: string) => (await at("/api/objects/airforce.Aircraft/AF86-0147", token)).json() as Promise<{ values?: Record<string, unknown> }>;
      expect((await read("demo-maintainer-token")).values).toHaveProperty("deploymentLocation");
      const viewer = await read("demo-viewer-token");
      expect(viewer.values).toBeDefined();
      expect(viewer.values).not.toHaveProperty("deploymentLocation");
      expect((await at("/api/objects/airforce.Aircraft/AF86-0147")).status).toBe(403);
    } finally {
      await server.close();
    }
  });
});
