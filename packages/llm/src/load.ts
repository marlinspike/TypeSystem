import { readFile } from "node:fs/promises";
import { LLM_CONFIG_FORMAT, type LlmConfig } from "./config.js";
import { LlmError } from "./errors.js";

/**
 * The deployment's model configuration from a JSON file: `path`, else
 * `$TYPESYS_LLM_CONFIG`, else `typesys.llm.json` in the working directory.
 * Undefined when there is none, since TypeSystem runs without one. Keys are
 * never in the file: it names the variables that hold them.
 */
export async function loadLlmConfig(path?: string): Promise<LlmConfig | undefined> {
  const file = path ?? process.env.TYPESYS_LLM_CONFIG ?? "typesys.llm.json";
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && path === undefined) return undefined;
    throw new LlmError("configuration", `Cannot read model configuration ${file}: ${(err as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new LlmError("configuration", `Model configuration ${file} is not JSON`);
  }
  if ((doc as { format?: unknown })?.format !== LLM_CONFIG_FORMAT) throw new LlmError("configuration", `Model configuration ${file} is not ${LLM_CONFIG_FORMAT}`);
  return doc as LlmConfig;
}
