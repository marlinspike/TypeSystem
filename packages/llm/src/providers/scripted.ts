import { canonical } from "@typesys/core";
import { createHash } from "node:crypto";
import { LlmError } from "../errors.js";
import type { AdapterRequest, DiscoveredModel, ProviderAdapter, ProviderResponse, ProviderStreamEvent, ToolCall } from "../types.js";

/** What a scripted model answers: text, a value to answer as JSON, tool calls, or an error to raise. */
export type ScriptedAnswer =
  | string
  | { readonly text?: string; readonly json?: unknown; readonly toolCalls?: readonly ToolCall[]; readonly finishReason?: ProviderResponse["finishReason"] }
  | { readonly error: LlmError };

/**
 * A provider that answers from a script (ADR-0074): a function of the
 * request, or a list of answers in order. For tests, for demonstrations
 * that must not depend on a live model, and for replaying a recorded
 * session. Usage is estimated from the text, as for a provider that
 * reports none.
 */
export function scriptedAdapter(script: ((request: AdapterRequest, model: string) => ScriptedAnswer | Promise<ScriptedAnswer>) | readonly ScriptedAnswer[], models: readonly string[] = ["scripted"]): ProviderAdapter & { readonly requests: AdapterRequest[] } {
  const queue = Array.isArray(script) ? [...(script as readonly ScriptedAnswer[])] : undefined;
  const requests: AdapterRequest[] = [];
  const answer = async (model: string, request: AdapterRequest, signal: AbortSignal): Promise<ProviderResponse> => {
    if (signal.aborted) throw new LlmError("cancelled", "cancelled");
    requests.push(request);
    const a = queue ? queue.shift() : await (script as (r: AdapterRequest, m: string) => ScriptedAnswer | Promise<ScriptedAnswer>)(request, model);
    if (a === undefined) throw new LlmError("unavailable", "The script has no more answers", { retryable: false });
    if (typeof a === "object" && "error" in a) throw a.error;
    const text = typeof a === "string" ? a : (a.text ?? (a.json !== undefined ? JSON.stringify(a.json) : ""));
    const toolCalls = typeof a === "string" ? [] : (a.toolCalls ?? []);
    const input = JSON.stringify(request.messages) + (request.system ?? "");
    return {
      text,
      toolCalls,
      finishReason: typeof a === "string" ? "stop" : (a.finishReason ?? (toolCalls.length ? "tool-calls" : "stop")),
      usage: { inputTokens: Math.ceil(input.length / 4), outputTokens: Math.ceil((text + (toolCalls.length ? JSON.stringify(toolCalls) : "")).length / 4), estimated: true },
      served: model
    };
  };
  return {
    kind: "scripted",
    requests,
    generate: answer,
    async *stream(model, request, signal): AsyncIterable<ProviderStreamEvent> {
      const r = await answer(model, request, signal);
      for (const piece of r.text.match(/[\s\S]{1,16}/g) ?? []) yield { type: "text", text: piece };
      yield { type: "done", response: r };
    },
    async listModels(): Promise<DiscoveredModel[]> {
      return models.map((id) => ({ id }));
    }
  };
}

/** The digest a recording keys an answer by: the request as the adapter received it. */
export const requestKey = (model: string, request: AdapterRequest): string => createHash("sha256").update(canonical({ model, request })).digest("hex");

export const RECORDING_FORMAT = "typesys.llm-recording/1";

/**
 * One answer recorded for one exact request (ADR-0076): what makes a
 * demonstration or a test repeatable without the model that answered.
 * `producedBy` says who answered, honestly: a configured model, or a coding
 * agent acting as the development model.
 */
export interface LlmRecording {
  readonly format: typeof RECORDING_FORMAT;
  /** `requestKey` of the request as the adapter received it. */
  readonly key: string;
  readonly producedBy: string;
  readonly at: string;
  readonly answer: { readonly text?: string; readonly json?: unknown };
}

/**
 * A provider that answers only requests it has a recording of, and fails
 * any other as unavailable (not retried): a request that changed since it
 * was recorded is never answered with an answer to a different one.
 */
export function replayAdapter(recordings: readonly LlmRecording[], models: readonly string[] = ["recorded"]): ProviderAdapter & { readonly requests: AdapterRequest[] } {
  const byKey = new Map(recordings.map((r) => [r.key, r]));
  return scriptedAdapter((request, model) => {
    const r = byKey.get(requestKey(model, request));
    if (!r) return { error: new LlmError("unavailable", `No recording answers this request to ${model}: it has changed since it was recorded, so record it again`, { retryable: false }) };
    return r.answer.json !== undefined ? { json: r.answer.json } : (r.answer.text ?? "");
  }, models);
}
