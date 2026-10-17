import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { squadronApp } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Inside the repository, so a compiled application resolves the workspace's packages as an installed one would. */
export const WORK = path.resolve(here, "..", ".work");

/** The enclave model the squadron's triage step asks, with the audience the Air Force policies grant `ai-enclave`. */
export const SQUADRON_LLM = {
  format: "typesys.llm/1",
  providers: { enclave: { kind: "custom", environment: "private" } },
  models: {
    enclave: {
      provider: "enclave",
      model: "triage-standin",
      uses: ["runtime"],
      audience: { id: "model:squadron-enclave/triage", roles: ["ai-enclave"], clearance: "CUI" }
    }
  }
};

/**
 * The squadron's server extension, as a developer would write it for a test
 * deployment: a deterministic stand-in for the enclave's model, so a run
 * reaches its approval without a model server. Nothing about it is special
 * to the compiler; it is an ordinary `llmOptions()`.
 */
export const STANDIN_SERVER = `import { scriptedAdapter, type LlmOptions } from "@typesys/llm";

export async function llmOptions(): Promise<LlmOptions> {
  return { adapters: { enclave: scriptedAdapter(() => ({ json: { eventId: "EVT-9002", priority: "urgent", rationale: "Unscheduled avionics fault." } })) } };
}
`;

/** A fresh squadron application directory: the spec, its LLM configuration and the stand-in model. */
export async function squadronDir(name: string, spec: unknown = squadronApp()): Promise<string> {
  const dir = path.join(WORK, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "src", "extensions"), { recursive: true });
  await writeFile(path.join(dir, "app.json"), `${JSON.stringify(spec, null, 2)}\n`);
  await writeFile(path.join(dir, "typesys.llm.json"), `${JSON.stringify(SQUADRON_LLM, null, 2)}\n`);
  await writeFile(path.join(dir, "src", "extensions", "server.ts"), STANDIN_SERVER);
  return dir;
}
