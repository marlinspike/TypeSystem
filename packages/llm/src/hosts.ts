import type { Audience } from "@typesys/core";
import { resolveConfig } from "./config.js";
import { LlmError } from "./errors.js";
import { loadLlmConfig } from "./load.js";

/**
 * The audience of the model behind the agent a host serves (ADR-0075), named
 * by `$TYPESYS_AGENT_MODEL` from the deployment's model configuration. An
 * MCP or HTTP host binds it, so an agent reads only what its user and its
 * model may both read. Unset, the host binds nothing. Set to a model that is
 * not configured, the host does not start: it never serves an agent as if
 * its model could receive anything.
 */
export async function agentAudienceFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): Promise<Audience | undefined> {
  const id = env.TYPESYS_AGENT_MODEL;
  if (!id) return undefined;
  const config = await loadLlmConfig(env.TYPESYS_LLM_CONFIG);
  if (!config) throw new LlmError("configuration", `TYPESYS_AGENT_MODEL is ${id}, and there is no model configuration (typesys.llm.json or TYPESYS_LLM_CONFIG)`);
  const model = resolveConfig(config).models.get(id);
  if (!model) throw new LlmError("configuration", `TYPESYS_AGENT_MODEL is ${id}, which is not a configured model`);
  return model.audience;
}
