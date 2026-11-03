/**
 * Writes every shipped deployment (ADR-0102) to deployments/, the files the
 * generic server runs (`node packages/host/dist/serve.js deployments/<name>.deployment.json`):
 *   npm run deployments              write them
 *   npm run deployments -- --check   fail if a committed file has drifted from its code
 *
 * Each is the deployment its package exports, written out unchanged, so the
 * file and the in-process host build to the same build id.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Deployment } from "@typesys/host";
import { coldChainDeployment, recallDeployment } from "@typesys/cold-chain";
import { sortieDeployment } from "@typesys/sortie-readiness";
import { airforceDeployment, airforceDurableDeployment, hospitalDeployment } from "@typesys/demo-web/deployments";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEPLOYMENTS: readonly Deployment[] = [airforceDeployment, airforceDurableDeployment, hospitalDeployment, coldChainDeployment, recallDeployment, sortieDeployment()];

export const deploymentFile = (d: Deployment): string => path.join(root, "deployments", `${d.name}.deployment.json`);

const serialize = (d: Deployment): string => `${JSON.stringify(d, null, 2)}\n`;

/** The committed files that differ from what their packages export now. */
export async function driftedDeployments(): Promise<string[]> {
  const drifted: string[] = [];
  for (const d of DEPLOYMENTS) if ((await readFile(deploymentFile(d), "utf8").catch(() => "")) !== serialize(d)) drifted.push(path.relative(root, deploymentFile(d)));
  return drifted;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const drifted = await driftedDeployments();
    if (drifted.length > 0) {
      console.error(`Drifted from the code (run npm run deployments): ${drifted.join(", ")}`);
      process.exitCode = 1;
    } else console.log("Deployment files match their packages.");
    return;
  }
  await mkdir(path.join(root, "deployments"), { recursive: true });
  for (const d of DEPLOYMENTS) {
    await writeFile(deploymentFile(d), serialize(d), "utf8");
    console.log(`Wrote ${path.relative(root, deploymentFile(d))}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
