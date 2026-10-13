import type { JsonSchema2020 } from "@typesys/core";

/** What an AI step asks of a model. */
export interface AiRequest {
  readonly workflow: string;
  readonly step: string;
  readonly prompt: string;
  readonly input: unknown;
  /** The model must answer with a value this schema admits; the engine checks, and refuses anything else. */
  readonly outputSchema: JsonSchema2020;
}

/**
 * The seam to a language model (ADR-0057). The engine depends on nothing
 * else of it: a hosted model, a local one in a disconnected enclave, or a
 * script in a test. Its answer is journaled as the model's, under `id`.
 */
export interface AiModel {
  readonly id: string;
  complete(request: AiRequest): Promise<unknown>;
}

/** A model that answers from a script, by step (a value, or a function of the request): for tests, simulation, and demonstrations that must not depend on a live model. */
export function scriptedModel(answers: Readonly<Record<string, unknown>>, id = "scripted"): AiModel {
  return {
    id,
    complete: async (request) => {
      if (!Object.hasOwn(answers, request.step)) throw new Error(`No scripted answer for AI step "${request.step}"`);
      const answer = answers[request.step];
      return typeof answer === "function" ? (answer as (r: AiRequest) => unknown)(request) : structuredClone(answer);
    }
  };
}
