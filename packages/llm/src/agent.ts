import { LlmError } from "./errors.js";
import { createLlm } from "./llm.js";
import type { LanguageModel } from "./model.js";
import type { LlmConfig, ModelConfig } from "./config.js";
import { RECORDING_FORMAT, replayAdapter, requestKey, scriptedAdapter, type LlmRecording } from "./providers/scripted.js";
import type { AdapterRequest, ProviderAdapter } from "./types.js";

/** The configured id of the development model in agent mode. */
export const AGENT_MODEL = "agent";
/** The id the agent's provider reports for it, which recordings are keyed by. */
export const AGENT_PROVIDER_MODEL = "coding-agent";

/**
 * Agent mode (ADR-0076): the development model is the coding agent the
 * engineer is already working with, not a provider TypeSystem calls. The
 * agent reads the request a configured model would be sent and answers it;
 * the answer is recorded against that exact request and replayed through
 * the model layer, so it is validated, checked and accounted for like any
 * model's.
 *
 * A coding agent runs on a hosted model, so it is declared `hosted`, and
 * for development only. Its audience is what the deployment grants it:
 * without one it is granted nothing, and is given only what needs no
 * grant.
 */
export function agentModelConfig(audience?: ModelConfig["audience"]): LlmConfig {
  return {
    format: "typesys.llm/1",
    version: "agent-mode",
    providers: { agent: { kind: "custom", environment: "hosted" } },
    models: { [AGENT_MODEL]: { provider: "agent", model: AGENT_PROVIDER_MODEL, uses: ["development"], capabilities: { structuredOutput: "schema" }, quality: "advanced", ...(audience ? { audience } : {}) } },
    defaults: { development: AGENT_MODEL }
  };
}

function agentModel(adapter: ProviderAdapter, audience?: ModelConfig["audience"]): LanguageModel {
  return createLlm(agentModelConfig(audience), { adapters: { agent: adapter } }).model(AGENT_MODEL, "development", { fallback: false });
}

/** The agent's recorded answers as a development model. A request that is not exactly one recorded is refused, never answered with another's answer. */
export function recordedModel(recordings: readonly LlmRecording[], audience?: ModelConfig["audience"]): LanguageModel {
  return agentModel(replayAdapter(recordings, [AGENT_PROVIDER_MODEL]), audience);
}

/**
 * A development model whose answers are the agent's, given in order: each
 * is recorded against the request it answers, as it is asked. When the
 * answers run out, the next request fails (`unavailable`, not retried) and
 * `needed()` returns it, for the agent to answer.
 */
export function answeringModel(answers: readonly unknown[], producedBy: string, options: { readonly audience?: ModelConfig["audience"]; readonly at?: () => string } = {}): { model: LanguageModel; recordings: LlmRecording[]; needed: () => AdapterRequest | undefined } {
  const recordings: LlmRecording[] = [];
  const queue = [...answers];
  let pending: AdapterRequest | undefined;
  const adapter = scriptedAdapter((request, model) => {
    if (queue.length === 0) {
      pending = request;
      return { error: new LlmError("unavailable", "The coding agent has not answered this request yet", { retryable: false }) };
    }
    const json = queue.shift();
    recordings.push({ format: RECORDING_FORMAT, key: requestKey(model, request), producedBy, at: options.at?.() ?? new Date().toISOString(), answer: { json } });
    return { json };
  }, [AGENT_PROVIDER_MODEL]);
  return { model: agentModel(adapter, options.audience), recordings, needed: () => pending };
}

/** A request as text an agent can read: the system prompt, the conversation so far, and the schema its answer must satisfy. */
export function requestText(request: AdapterRequest): string {
  const turns = request.messages.map((m) => `${m.role.toUpperCase()}:\n${typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n")}`);
  return [`SYSTEM:\n${request.system ?? ""}`, ...turns, ...(request.output ? [`ANSWER with one JSON object this schema admits:\n${JSON.stringify(request.output.schema, null, 2)}`] : [])].join("\n\n");
}
