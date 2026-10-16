import type { ResolvedProvider } from "../config.js";
import { LlmError } from "../errors.js";
import { jsonInstruction } from "../structured.js";
import type { AdapterRequest, DiscoveredModel, FinishReason, Message, ProviderAdapter, ProviderResponse, ProviderStreamEvent, ToolCall, Usage } from "../types.js";
import { estimateUsage, normalizeSdkError, type Secrets, headersFor, loadSdk, secretValues } from "./shared.js";

type AnthropicModule = typeof import("@anthropic-ai/sdk");
type Anthropic = InstanceType<AnthropicModule["default"]>;
type Block = Record<string, unknown> & { type: string };

const PROTOCOL = "anthropic";

const STOP: Readonly<Record<string, FinishReason>> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool-calls",
  refusal: "refusal",
  pause_turn: "other"
};

/**
 * Native Claude Messages API (ADR-0074), through Anthropic's own SDK with
 * its retries off: TypeSystem retries, so every provider retries the same
 * way. Native because it is where structured outputs, tool use and the
 * thinking blocks a tool loop must echo back are exact.
 */
export async function anthropicAdapter(provider: ResolvedProvider, secrets: Secrets): Promise<ProviderAdapter> {
  const sdk = await loadSdk<AnthropicModule>("@anthropic-ai/sdk", provider.kind);
  const apiKey = provider.apiKeyEnv ? secrets(provider.apiKeyEnv) : undefined;
  if (!apiKey) throw new LlmError("configuration", `Provider ${provider.name} needs ${provider.apiKeyEnv ?? "an API key"} set`, { provider: provider.name });
  const client: Anthropic = new sdk.default({
    apiKey,
    baseURL: provider.baseUrl,
    maxRetries: 0,
    timeout: provider.timeoutMs,
    defaultHeaders: headersFor(provider, secrets)
  });
  const known = secretValues(provider, secrets);
  const fail = (err: unknown): never => {
    throw normalizeSdkError(err, provider, known);
  };

  return {
    kind: provider.kind,
    async generate(model, request, signal) {
      try {
        const message = await client.messages.create(body(model, request, false) as never, { signal });
        return responseOf(message as unknown as Record<string, unknown>);
      } catch (err) {
        return fail(err);
      }
    },
    async *stream(model, request, signal): AsyncIterable<ProviderStreamEvent> {
      let events: AsyncIterable<Record<string, unknown>>;
      try {
        events = (await client.messages.create(body(model, request, true) as never, { signal })) as unknown as AsyncIterable<Record<string, unknown>>;
      } catch (err) {
        return fail(err);
      }
      const blocks: Block[] = [];
      const partialJson = new Map<number, string>();
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stop: string | undefined;
      let served: string | undefined;
      let stopped = false;
      try {
        for await (const e of events) {
          switch (e.type) {
            case "message_start": {
              const m = e.message as Record<string, unknown>;
              served = m.model as string | undefined;
              usage = usageOf(m.usage);
              break;
            }
            case "content_block_start":
              blocks[e.index as number] = { ...(e.content_block as Block) };
              break;
            case "content_block_delta": {
              const i = e.index as number;
              const d = e.delta as Record<string, unknown>;
              const b = blocks[i];
              if (!b) throw new LlmError("malformed-response", "The stream sent a delta for a block it never started", { provider: provider.name });
              if (d.type === "text_delta") {
                b.text = `${(b.text as string | undefined) ?? ""}${d.text as string}`;
                yield { type: "text", text: d.text as string };
              } else if (d.type === "input_json_delta") partialJson.set(i, `${partialJson.get(i) ?? ""}${d.partial_json as string}`);
              else if (d.type === "thinking_delta") b.thinking = `${(b.thinking as string | undefined) ?? ""}${d.thinking as string}`;
              else if (d.type === "signature_delta") b.signature = d.signature;
              break;
            }
            case "content_block_stop": {
              const i = e.index as number;
              const b = blocks[i];
              if (b?.type === "tool_use" && partialJson.has(i)) {
                try {
                  b.input = JSON.parse(partialJson.get(i) || "{}");
                } catch {
                  throw new LlmError("malformed-response", `The model's arguments for tool "${String(b.name)}" are not JSON`, { provider: provider.name });
                }
              }
              break;
            }
            case "message_delta": {
              const d = e.delta as Record<string, unknown>;
              if (typeof d.stop_reason === "string") stop = d.stop_reason;
              const u = e.usage as Record<string, unknown> | undefined;
              if (u && typeof u.output_tokens === "number") usage = { ...usage, outputTokens: u.output_tokens };
              break;
            }
            case "message_stop":
              stopped = true;
              break;
            default:
              break;
          }
        }
      } catch (err) {
        return fail(err);
      }
      if (!stopped || stop === undefined) throw new LlmError("malformed-response", "The stream ended before the answer finished", { provider: provider.name });
      yield { type: "done", response: responseOf({ content: blocks.filter(Boolean), stop_reason: stop, usage: undefined, model: served }, usage) };
    },
    async listModels(signal) {
      const out: DiscoveredModel[] = [];
      try {
        for await (const m of client.models.list({ limit: 100 }, { signal })) {
          const info = m as unknown as Record<string, unknown>;
          const caps = (info.capabilities ?? {}) as Record<string, { supported?: boolean } | undefined>;
          out.push({
            id: String(info.id),
            ...(typeof info.display_name === "string" ? { displayName: info.display_name } : {}),
            capabilities: {
              ...(typeof info.max_input_tokens === "number" ? { contextWindow: info.max_input_tokens } : {}),
              ...(typeof info.max_tokens === "number" ? { maxOutputTokens: info.max_tokens } : {}),
              ...(caps.structured_outputs ? { structuredOutput: caps.structured_outputs.supported ? ("schema" as const) : ("none" as const) } : {}),
              ...(caps.image_input ? { input: caps.image_input.supported ? (["text", "image"] as const) : (["text"] as const) } : {})
            }
          });
        }
      } catch (err) {
        return fail(err);
      }
      return out;
    }
  };
}

function body(model: string, r: AdapterRequest, stream: boolean): Record<string, unknown> {
  const instruction = r.output && r.structured !== "schema" ? jsonInstruction(r.output.schema) : undefined;
  const system = [r.system, instruction, r.toolChoice === "required" ? "You must answer by calling one of the provided tools." : undefined].filter(Boolean).join("\n\n");
  return {
    model,
    max_tokens: r.maxOutputTokens ?? 8192,
    ...(system ? { system } : {}),
    messages: messagesOf(r.messages),
    ...(r.tools?.length ? { tools: r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
    // Forced tool choice is refused by current Claude models: "required" is asked for in the instruction and checked on the answer.
    ...(r.tools?.length && r.toolChoice ? { tool_choice: { type: r.toolChoice === "none" ? "none" : "auto" } } : {}),
    ...(r.output && r.structured === "schema" ? { output_config: { format: { type: "json_schema", schema: r.output.schema } } } : {}),
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
    ...(r.stopSequences?.length ? { stop_sequences: [...r.stopSequences] } : {}),
    ...(stream ? { stream: true } : {})
  };
}

function messagesOf(messages: readonly Message[]): Record<string, unknown>[] {
  const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
  const push = (role: "user" | "assistant", blocks: unknown[]) => {
    const last = out.at(-1);
    // Consecutive turns of one role are one turn: parallel tool results go back together.
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") {
      push("user", typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } })));
    } else if (m.role === "assistant") {
      if (m.opaque?.protocol === PROTOCOL && Array.isArray(m.opaque.data)) push("assistant", [...(m.opaque.data as unknown[])]);
      else
        push("assistant", [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} }))
        ]);
    } else {
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) }]);
    }
  }
  return out;
}

function usageOf(u: unknown): Usage {
  const x = (u ?? {}) as Record<string, number | null | undefined>;
  const cached = x.cache_read_input_tokens ?? 0;
  return {
    inputTokens: (x.input_tokens ?? 0) + (x.cache_creation_input_tokens ?? 0) + cached,
    outputTokens: x.output_tokens ?? 0,
    ...(cached > 0 ? { cachedInputTokens: cached } : {})
  };
}

function responseOf(m: Record<string, unknown>, streamed?: Usage): ProviderResponse {
  const content = (Array.isArray(m.content) ? m.content : []) as Block[];
  const text = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
  const toolCalls: ToolCall[] = content.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), input: b.input ?? {} }));
  const stop = typeof m.stop_reason === "string" ? m.stop_reason : undefined;
  if (stop === undefined) throw new LlmError("malformed-response", "The answer has no stop reason");
  const usage = streamed ?? (m.usage ? usageOf(m.usage) : estimateUsage("", text));
  const echo = content.some((b) => b.type === "thinking" || b.type === "redacted_thinking") && toolCalls.length > 0;
  return {
    text,
    toolCalls,
    finishReason: STOP[stop] ?? "other",
    usage,
    ...(typeof m.model === "string" ? { served: m.model } : {}),
    ...(echo ? { opaque: { protocol: PROTOCOL, data: content } } : {})
  };
}
