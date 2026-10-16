import { createLlm, RECORDING_FORMAT, replayAdapter, requestKey, scriptedAdapter, type LanguageModel, type LlmConfig, type LlmRecording, type ProviderAdapter } from "@typesys/llm";
import type { Proposal } from "./proposal.js";
import { refine, type Refinement } from "./refine.js";
import type { SourceModel } from "./sources.js";

/** The configured id of the development model in agent mode. */
export const AGENT_MODEL = "agent";

/**
 * Agent mode (ADR-0076): the development model is the coding agent the
 * engineer is already working with, not a provider TypeSystem calls. The
 * agent reads the same request a configured model would be sent, answers
 * it, and the answer is recorded against that exact request; onboarding
 * then replays it through the same model layer, so the answer is validated
 * against the schema, checked against the evidence and accounted for like
 * any model's. The configuration declares it local and for development
 * only: it is never offered to the runtime.
 */
export function agentModelConfig(): LlmConfig {
  return {
    format: "typesys.llm/1",
    version: "agent-mode",
    providers: { agent: { kind: "custom", environment: "local" } },
    models: { [AGENT_MODEL]: { provider: "agent", model: "coding-agent", uses: ["development"], capabilities: { structuredOutput: "schema" }, quality: "advanced" } },
    defaults: { development: AGENT_MODEL }
  };
}

function agentModel(adapter: ProviderAdapter): LanguageModel {
  return createLlm(agentModelConfig(), { adapters: { agent: adapter } }).model(AGENT_MODEL, "development", { fallback: false });
}

/** The agent's recorded answers as a development model: a request that is not exactly the one recorded is refused, never answered with another's answer. */
export function recordedModel(recordings: readonly LlmRecording[]): LanguageModel {
  return agentModel(replayAdapter(recordings, ["coding-agent"]));
}

/**
 * Records an agent's answer to the refinement request for `base`: the
 * request is made through the model layer exactly as `refine` makes it, so
 * the recording's key is the request a replay will make. Returns the
 * recording and the proposal the answer refines to, rejections included.
 */
export async function recordRefinement(model: SourceModel, base: Proposal, answer: Refinement, producedBy: string, at = new Date().toISOString()): Promise<{ recording: LlmRecording; proposal: Proposal }> {
  const adapter = scriptedAdapter([{ json: answer }], ["coding-agent"]);
  const { proposal } = await refine(model, base, agentModel(adapter));
  const request = adapter.requests[0]!;
  return { recording: { format: RECORDING_FORMAT, key: requestKey("coding-agent", request), producedBy, at, answer: { json: answer } }, proposal };
}
