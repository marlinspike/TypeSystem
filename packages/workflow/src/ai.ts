import type { Audience, JsonSchema2020 } from "@typesys/core";

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
  /**
   * Who receives what this model is sent (ADR-0067): its provider, where it
   * runs, and what policy grants it. An AI step's input is only what both the
   * person carrying the run and this audience may read. Omitted, the model
   * is an audience granted nothing (`model:<id>`), so it receives only what
   * a policy grants everyone.
   */
  readonly audience?: Audience;
  /**
   * Models to ask, in order, when this one fails with an error that says it
   * may succeed elsewhere (`retryable`: unavailable, overloaded, timed out).
   * Each is a release of its own (ADR-0075): the engine computes the step's
   * input again for its audience, refuses it as it would refuse this model,
   * journals and audits what it sent, and never sends it what this model
   * was given unless its audience may receive it.
   */
  readonly fallbacks?: readonly AiModel[];
  complete(request: AiRequest): Promise<unknown>;
}

/** The audience a model's input is released to: its own, or one granted nothing. */
export function audienceOf(model: AiModel): Audience {
  return model.audience ?? { id: `model:${model.id}`, kind: "model", roles: [], attributes: {} };
}

/** A model that answers from a script, by step (a value, or a function of the request): for tests, simulation, and demonstrations that must not depend on a live model. */
export function scriptedModel(answers: Readonly<Record<string, unknown>>, id = "scripted", audience?: Audience): AiModel {
  return {
    id,
    ...(audience ? { audience } : {}),
    complete: async (request) => {
      if (!Object.hasOwn(answers, request.step)) throw new Error(`No scripted answer for AI step "${request.step}"`);
      const answer = answers[request.step];
      return typeof answer === "function" ? (answer as (r: AiRequest) => unknown)(request) : structuredClone(answer);
    }
  };
}
