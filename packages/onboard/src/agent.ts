import { answeringModel, type LlmRecording } from "@typesys/llm";
export { agentModelConfig, recordedModel } from "@typesys/llm";
import type { Proposal } from "./proposal.js";
import { refine, type Refinement } from "./refine.js";
import type { SourceModel } from "./sources.js";

/**
 * Records a coding agent's answer to the refinement request for `base`
 * (agent mode, ADR-0076): the request is made through the model layer
 * exactly as `refine` makes it, so the recording's key is the request a
 * replay (`recordedModel`) will make. Returns the recording and the
 * proposal the answer refines to, rejections included.
 */
export async function recordRefinement(model: SourceModel, base: Proposal, answer: Refinement, producedBy: string, at = new Date().toISOString()): Promise<{ recording: LlmRecording; proposal: Proposal }> {
  const agent = answeringModel([answer], producedBy, { at: () => at });
  const { proposal } = await refine(model, base, agent.model);
  return { recording: agent.recordings[0]!, proposal };
}
