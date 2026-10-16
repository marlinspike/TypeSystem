import type { JsonSchema2020 } from "@typesys/core";

/**
 * What a model can do (ADR-0074). Declared in configuration, defaulted from
 * the provider's profile, and checked against what discovery reports. A
 * request that needs something the model does not declare fails before
 * anything is sent: models are interchangeable, capabilities are not.
 */
export interface ModelCapabilities {
  /** Input the model accepts besides text. */
  readonly input: readonly ("text" | "image")[];
  /** Function calling: the model may answer with tool calls. */
  readonly tools: boolean;
  /** More than one tool call in one answer. */
  readonly parallelToolCalls: boolean;
  /** Incremental output over a stream. */
  readonly streaming: boolean;
  /**
   * How the provider constrains output to a JSON Schema: `schema` (it
   * enforces the schema while generating), `json` (it guarantees JSON, not
   * the schema), or `none` (only the instruction asks for it). Whatever this
   * says, every structured answer is validated again by TypeSystem.
   */
  readonly structuredOutput: "schema" | "json" | "none";
  /** A system instruction separate from the conversation. */
  readonly systemPrompt: boolean;
  /** A sampling temperature; some reasoning models reject one. */
  readonly temperature: boolean;
  /** A seed the provider uses to make sampling repeatable (best effort on every provider that has one). */
  readonly seed: boolean;
  /** Tokens of input the model reads, when known. */
  readonly contextWindow?: number;
  /** Tokens of output one answer may have, when known. */
  readonly maxOutputTokens?: number;
}

/** A capability a request needs, by name, with what it needs of it. */
export type CapabilityRequirement =
  | { readonly capability: "tools" | "parallelToolCalls" | "streaming" | "systemPrompt" | "temperature" | "seed" }
  | { readonly capability: "input"; readonly kind: "image" }
  | { readonly capability: "structuredOutput"; readonly atLeast: "schema" | "json" | "none" }
  | { readonly capability: "contextWindow"; readonly atLeast: number }
  | { readonly capability: "maxOutputTokens"; readonly atLeast: number };

export type TextPart = { readonly type: "text"; readonly text: string };
/** An image, inline: base64 data and its media type. Remote URLs are not fetched on a model's behalf. */
export type ImagePart = { readonly type: "image"; readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; readonly data: string };
export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** The arguments the model generated, parsed; validated against the tool's schema before anything runs them. */
  readonly input: unknown;
}

export type Message =
  | { readonly role: "user"; readonly content: string | readonly ContentPart[] }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
      /**
       * Blocks a provider needs echoed back unchanged on the next turn (an
       * Anthropic model's thinking before a tool call). Opaque, and sent
       * only to the same kind of provider.
       */
      readonly opaque?: { readonly protocol: string; readonly data: unknown };
    }
  | { readonly role: "tool"; readonly toolCallId: string; readonly name: string; readonly content: string; readonly isError?: boolean };

export interface ToolSpec {
  /** `[A-Za-z0-9_-]{1,64}`, the strictest name every provider accepts. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema2020;
}

/**
 * The label of what a request carries (ADR-0075): the markings of the data
 * in it, decided against each model's audience by the deployment's
 * classification scheme before the model is called. `[]` says the content
 * is unmarked; leaving the label out says nothing, so a request without one
 * cannot fall back across a deployment boundary.
 */
export interface ContentLabel {
  readonly markings: readonly string[];
}

/** One call to a model, the same for every provider. */
export interface GenerateRequest {
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  /** `auto` (default), `none`, or `required` (some tool must be called). */
  readonly toolChoice?: "auto" | "none" | "required";
  /** Answer with JSON this schema admits. The answer is validated, whatever the provider promises. */
  readonly output?: { readonly schema: JsonSchema2020; readonly name?: string; readonly description?: string };
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly seed?: number;
  readonly stopSequences?: readonly string[];
  readonly label?: ContentLabel;
  /**
   * The id of the audience the content was read for (ADR-0075): content
   * the runtime released to one model's audience, as `withAudience(person,
   * model.info.audience)` reads it, was decided for that audience, and its
   * label does not say what else it holds. Only a model with this audience
   * may receive it: a fallback with another is refused, whatever the label.
   */
  readonly releasedFor?: string;
  /** What the call is for, recorded with its usage (`onboarding.propose`, `engineer.draft`); never content. */
  readonly purpose?: string;
}

export type FinishReason = "stop" | "length" | "tool-calls" | "refusal" | "content-filter" | "other";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from a provider's prompt cache, when it reports them. */
  readonly cachedInputTokens?: number;
  /** True when the provider reported no usage and these are estimated from the text (four characters a token). */
  readonly estimated?: boolean;
}

export interface Cost {
  readonly amount: number;
  readonly currency: "USD";
  /** `configured`: from the model's configured prices. A model with none configured has no cost, not a zero one. */
  readonly basis: "configured";
}

/**
 * What makes a call repeatable and auditable without its content: digests of
 * the model's configuration and of the request, the parameters, which model
 * actually answered, and how. Content is never in it.
 */
export interface CallRecord {
  readonly callId: string;
  readonly at: string;
  readonly purpose?: string;
  readonly model: { readonly id: string; readonly provider: string; readonly providerModel: string; readonly version?: string; readonly served?: string };
  readonly audience: string;
  readonly configDigest: string;
  readonly requestDigest: string;
  readonly parameters: { readonly temperature?: number; readonly seed?: number; readonly maxOutputTokens?: number; readonly structured?: "schema" | "json" | "none" };
  readonly attempts: number;
  readonly finishReason?: FinishReason;
  readonly usage?: Usage;
  readonly cost?: Cost;
  readonly latencyMs: number;
  readonly timeToFirstTokenMs?: number;
  readonly responseDigest?: string;
  /** Set when a fallback answered: the model that failed, and why. */
  readonly fallbackFrom?: { readonly model: string; readonly code: string };
  readonly error?: { readonly code: string; readonly message: string };
}

export interface GenerateResult {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  /** The answer parsed and validated against `output.schema`, when the request asked for one. */
  readonly object?: unknown;
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  readonly cost?: Cost;
  readonly record: CallRecord;
  /** The answer as the next turn's assistant message, opaque provider blocks included, for a conversation or a tool loop to append. */
  readonly message: Extract<Message, { role: "assistant" }>;
}

export type StreamEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ToolCall }
  | { readonly type: "finish"; readonly result: GenerateResult };

export interface CallOptions {
  readonly signal?: AbortSignal;
  /** The whole call, retries included. */
  readonly timeoutMs?: number;
  /** Attempts in all (the first included) for errors that are retryable. Default from the provider config, else 3. */
  readonly maxAttempts?: number;
}

/** What a provider adapter answers for one attempt: unvalidated, unaccounted, unretried. */
export interface ProviderResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  /** The model id the provider says served the call, if it says. */
  readonly served?: string;
  /** Provider blocks to echo back with this answer on the next turn (see `Message`). */
  readonly opaque?: { readonly protocol: string; readonly data: unknown };
}

/** One attempt's stream, from an adapter: text and tool calls as they arrive, then the whole response. */
export type ProviderStreamEvent = { readonly type: "text"; readonly text: string } | { readonly type: "done"; readonly response: ProviderResponse };

/** A model the provider lists, with whatever it says about it. */
export interface DiscoveredModel {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities?: Partial<ModelCapabilities>;
  /** Anything else the provider reports that a person deciding about the model would want (family, size, quantization). */
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The protocol seam (ADR-0074): one provider's wire format, behind which
 * every TypeSystem concern (capabilities, validation, retries, accounting,
 * release) is the same. An adapter translates and normalizes errors into
 * `LlmError`; it does not retry, validate or account.
 */
export interface ProviderAdapter {
  readonly kind: string;
  generate(model: string, request: AdapterRequest, signal: AbortSignal): Promise<ProviderResponse>;
  stream(model: string, request: AdapterRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  listModels(signal: AbortSignal): Promise<DiscoveredModel[]>;
}

/** A request as an adapter receives it: decided, checked and with its structured-output mode chosen. */
export interface AdapterRequest extends GenerateRequest {
  /** How to ask for `output`: the strongest mode the model declares. */
  readonly structured?: "schema" | "json" | "none";
}
