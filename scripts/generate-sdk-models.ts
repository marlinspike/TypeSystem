/**
 * Generates each demo domain's typed SDK model (ADR-0055) beside the domain:
 *   npm run sdk:models            write them
 *   npm run sdk:models -- --check fail if a committed model has drifted from its registry
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateModel } from "@typesys/sdk";
import { buildAirforceTestbed } from "@typesys/domain-airforce";
import { buildHospitalTestbed } from "@typesys/domain-hospital";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SDK_MODELS = [
  {
    file: path.join(root, "packages/domain-airforce/src/model.generated.ts"),
    generate: async () => generateModel((await buildAirforceTestbed()).registry, { name: "AirforceModel", prefixes: ["airforce."] })
  },
  {
    file: path.join(root, "packages/domain-hospital/src/model.generated.ts"),
    generate: async () => generateModel((await buildHospitalTestbed()).registry, { name: "HospitalModel", prefixes: ["hospital."] })
  }
];

/** The committed models that differ from what their registries generate now. */
export async function driftedModels(): Promise<string[]> {
  const drifted: string[] = [];
  for (const { file, generate } of SDK_MODELS) {
    const committed = await readFile(file, "utf8").catch(() => "");
    if (committed !== (await generate())) drifted.push(path.relative(root, file));
  }
  return drifted;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const drifted = await driftedModels();
    if (drifted.length > 0) {
      console.error(`Drifted from the registry (run npm run sdk:models): ${drifted.join(", ")}`);
      process.exitCode = 1;
    } else console.log("SDK models match their registries.");
    return;
  }
  for (const { file, generate } of SDK_MODELS) {
    await writeFile(file, await generate(), "utf8");
    console.log(`Wrote ${path.relative(root, file)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
