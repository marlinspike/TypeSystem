/**
 * Writes each demo domain's pack archive (ADR-0059) to packs/, the files an
 * offline deployment copies and installs:
 *   npm run packs              write them
 *   npm run packs -- --check   fail if a committed archive has drifted from its domain
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corePack, type PackArchive } from "@typesys/packs";
import { airforcePack } from "@typesys/domain-airforce";
import { hospitalPack } from "@typesys/domain-hospital";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PACKS: readonly PackArchive[] = [corePack, airforcePack, hospitalPack];

export const packFile = (p: PackArchive): string => path.join(root, "packs", `${p.name}-${p.version}.typesys-pack.json`);

const serialize = (p: PackArchive): string => `${JSON.stringify(p, null, 2)}\n`;

/** The committed archives that differ from what their domains build now. */
export async function driftedPacks(): Promise<string[]> {
  const drifted: string[] = [];
  for (const p of PACKS) if ((await readFile(packFile(p), "utf8").catch(() => "")) !== serialize(p)) drifted.push(path.relative(root, packFile(p)));
  return drifted;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const drifted = await driftedPacks();
    if (drifted.length > 0) {
      console.error(`Drifted from the domain (run npm run packs): ${drifted.join(", ")}`);
      process.exitCode = 1;
    } else console.log("Pack archives match their domains.");
    return;
  }
  for (const p of PACKS) {
    await writeFile(packFile(p), serialize(p), "utf8");
    console.log(`Wrote ${path.relative(root, packFile(p))} (${p.digest})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
