import type * as OpenAISdk from "openai";
import type { ResolvedProvider } from "../config.js";
import { LlmError } from "../errors.js";
import { jsonInstruction, strictCompatible } from "../structured.js";
import type { AdapterRequest, DiscoveredModel, FinishReason, Message, ModelCapabilities, ProviderAdapter, ProviderStreamEvent, ToolCall, Usage } from "../types.js";
import { estimateUsage, headersFor, loadSdk, normalizeSdkError, secretValues, type Secrets } from "./shared.js";

type OpenAIModule = typeof OpenAISdk;
type OpenAI = InstanceType<OpenAIModule["default"]>;

const FINISH: Readonly<Record<string, FinishReason>> = { stop: "stop", length: "length", tool_calls: "tool-calls", function_call: "tool-calls", content_filter: "content-filter" };

/**
 * The Chat Completions protocol (ADR-0074) for OpenAI and every server that
 * speaks it: OpenRouter, Ollama, LM Studio, vLLM and any other compatible
 * endpoint, through OpenAI's SDK with its retries off. Speaking the same
 * protocol makes them reachable the same way, not equivalent: each kind's
 * profile says which parameter caps output and whether usage streams, and
 * each model's capabilities say what it can do.
 */
export async function openAiChatAdapter(provider: ResolvedProvider, secrets: Secrets): Promise<ProviderAdapter> {
  const sdk = await loadSdk<OpenAIModule>("openai", provider.kind);
  const key = provider.apiKeyEnv ? secrets(provider.apiKeyEnv) : undefined;
  if (provider.profile.apiKey === "required" && !key) throw new LlmError("configuration", `Provider ${provider.name} needs ${provider.apiKeyEnv ?? "an API key"} set`, { provider: provider.name });
  const headers = headersFor(provider, secrets);
  const client: OpenAI = new sdk.default({
    // A local server takes any key; the SDK insists on one.
    apiKey: key ?? "unused",
    baseURL: provider.baseUrl,
    maxRetries: 0,
    timeout: provider.timeoutMs,
    defaultHeaders: headers
  });
  const known = secretValues(provider, secrets);
  const fail = (err: unknown): never => {
    throw normalizeSdkError(err, provider, known);
  };
  const dialect = provider.profile.chat!;

  return {
    kind: provider.kind,
    async generate(model, request, signal) {
      let completion: Record<string, unknown>;
      try {
        completion = (await client.chat.completions.create(body(model, request, dialect, false) as never, { signal })) as unknown as Record<string, unknown>;
      } catch (err) {
        return fail(err);
      }
      const choice = (completion.choices as Record<string, unknown>[] | undefined)?.[0];
      if (!choice) throw new LlmError("malformed-response", `${provider.name} answered with no choices`, { provider: provider.name });
      const message = (choice.message ?? {}) as Record<string, unknown>;
      const text = typeof message.content === "string" ? message.content : "";
      const toolCalls = toolCallsOf(message.tool_calls, provider.name);
      const refused = typeof message.refusal === "string" && message.refusal !== "";
      return {
        text,
        toolCalls,
        finishReason: refused ? "refusal" : (FINISH[String(choice.finish_reason)] ?? "other"),
        usage: completion.usage ? usageOf(completion.usage) : estimateUsage(JSON.stringify(request.messages), text),
        ...(typeof completion.model === "string" ? { served: completion.model } : {})
      };
    },
    async *stream(model, request, signal): AsyncIterable<ProviderStreamEvent> {
      let chunks: AsyncIterable<Record<string, unknown>>;
      try {
        chunks = (await client.chat.completions.create(body(model, request, dialect, true) as never, { signal })) as unknown as AsyncIterable<Record<string, unknown>>;
      } catch (err) {
        return fail(err);
      }
      let text = "";
      let finish: string | undefined;
      let refusal = "";
      let usage: Usage | undefined;
      let served: string | undefined;
      const calls = new Map<number, { id?: string; name?: string; args: string }>();
      try {
        for await (const c of chunks) {
          if (typeof c.model === "string") served = c.model;
          if (c.usage) usage = usageOf(c.usage);
          const choice = (c.choices as Record<string, unknown>[] | undefined)?.[0];
          if (!choice) continue;
          const delta = (choice.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.content === "string" && delta.content !== "") {
            text += delta.content;
            yield { type: "text", text: delta.content };
          }
          if (typeof delta.refusal === "string") refusal += delta.refusal;
          for (const t of (delta.tool_calls ?? []) as Record<string, unknown>[]) {
            const i = typeof t.index === "number" ? t.index : 0;
            const f = (t.function ?? {}) as Record<string, unknown>;
            const call = calls.get(i) ?? { args: "" };
            if (typeof t.id === "string") call.id = t.id;
            if (typeof f.name === "string") call.name = (call.name ?? "") + f.name;
            if (typeof f.arguments === "string") call.args += f.arguments;
            calls.set(i, call);
          }
          if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
        }
      } catch (err) {
        return fail(err);
      }
      if (finish === undefined) throw new LlmError("malformed-response", "The stream ended before the answer finished", { provider: provider.name });
      const toolCalls = toolCallsOf(
        [...calls.entries()].sort(([a], [b]) => a - b).map(([i, c]) => ({ id: c.id ?? `call_${i}`, type: "function", function: { name: c.name ?? "", arguments: c.args } })),
        provider.name
      );
      yield {
        type: "done",
        response: {
          text,
          toolCalls,
          finishReason: refusal ? "refusal" : (FINISH[finish] ?? "other"),
          usage: usage ?? estimateUsage(JSON.stringify(request.messages), text),
          ...(served ? { served } : {})
        }
      };
    },
    async listModels(signal) {
      if (provider.profile.discovery === "ollama") return ollamaModels(provider, headers, signal);
      if (provider.profile.discovery === "openrouter") return openRouterModels(provider, headers, key, signal);
      const out: DiscoveredModel[] = [];
      try {
        for await (const m of client.models.list({ signal })) out.push({ id: String((m as unknown as { id: string }).id) });
      } catch (err) {
        return fail(err);
      }
      return out;
    }
  };
}

function body(model: string, r: AdapterRequest, dialect: NonNullable<ResolvedProvider["profile"]["chat"]>, stream: boolean): Record<string, unknown> {
  const instruction = r.output && r.structured !== "schema" ? jsonInstruction(r.output.schema) : undefined;
  const system = [r.system, instruction].filter(Boolean).join("\n\n");
  const strict = r.output ? strictCompatible(r.output.schema) : false;
  return {
    model,
    messages: [...(system ? [{ role: "system", content: system }] : []), ...messagesOf(r.messages)],
    ...(r.maxOutputTokens !== undefined ? { [dialect.maxTokensParam]: r.maxOutputTokens } : {}),
    ...(r.tools?.length
      ? { tools: r.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema, ...(strictCompatible(t.inputSchema) ? { strict: true } : {}) } })) }
      : {}),
    ...(r.tools?.length && r.toolChoice ? { tool_choice: r.toolChoice } : {}),
    ...(r.output && r.structured === "schema"
      ? { response_format: { type: "json_schema", json_schema: { name: r.output.name ?? "answer", ...(r.output.description ? { description: r.output.description } : {}), schema: r.output.schema, strict } } }
      : r.output && r.structured === "json"
        ? { response_format: { type: "json_object" } }
        : {}),
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
    ...(r.seed !== undefined ? { seed: r.seed } : {}),
    ...(r.stopSequences?.length ? { stop: [...r.stopSequences] } : {}),
    // Only upstream providers that honor every parameter asked for (OpenRouter).
    ...(dialect.requireParameters ? { provider: { require_parameters: true } } : {}),
    ...(stream ? { stream: true, ...(dialect.streamUsage ? { stream_options: { include_usage: true } } : {}) } : {})
  };
}

function messagesOf(messages: readonly Message[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "user")
      return {
        role: "user",
        content: typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } }))
      };
    if (m.role === "assistant")
      return {
        role: "assistant",
        content: m.content === "" && m.toolCalls?.length ? null : m.content,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {})
      };
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  });
}

function toolCallsOf(raw: unknown, provider: string): ToolCall[] {
  return ((raw ?? []) as Record<string, unknown>[]).map((t, i) => {
    const f = (t.function ?? {}) as Record<string, unknown>;
    const args = typeof f.arguments === "string" ? f.arguments : "{}";
    let input: unknown;
    try {
      input = args.trim() === "" ? {} : JSON.parse(args);
    } catch {
      throw new LlmError("malformed-response", `The model's arguments for tool "${String(f.name)}" are not JSON`, { provider });
    }
    return { id: typeof t.id === "string" && t.id ? t.id : `call_${i}`, name: typeof f.name === "string" ? f.name : "", input };
  });
}

function usageOf(u: unknown): Usage {
  const x = (u ?? {}) as Record<string, unknown>;
  const cached = ((x.prompt_tokens_details ?? {}) as Record<string, unknown>).cached_tokens;
  return {
    inputTokens: typeof x.prompt_tokens === "number" ? x.prompt_tokens : 0,
    outputTokens: typeof x.completion_tokens === "number" ? x.completion_tokens : 0,
    ...(typeof cached === "number" && cached > 0 ? { cachedInputTokens: cached } : {})
  };
}

async function getJson(url: string, init: RequestInit, provider: ResolvedProvider): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new LlmError("cancelled", `Discovery at ${provider.name} was cancelled`, { provider: provider.name });
    throw new LlmError("unavailable", `${provider.name} could not be reached`, { provider: provider.name });
  }
  if (!res.ok) throw normalizeSdkError({ status: res.status, headers: res.headers, message: await res.text().catch(() => "") }, provider, []);
  try {
    return await res.json();
  } catch {
    throw new LlmError("malformed-response", `${provider.name} answered discovery with something that is not JSON`, { provider: provider.name });
  }
}

/**
 * Ollama's own API, for what its OpenAI-compatible one does not say: each
 * model's capabilities (tools, vision) and context length, from `/api/show`.
 */
async function ollamaModels(provider: ResolvedProvider, headers: Record<string, string>, signal: AbortSignal): Promise<DiscoveredModel[]> {
  const root = provider.baseUrl.replace(/\/v1$/, "");
  const tags = (await getJson(`${root}/api/tags`, { headers, signal }, provider)) as { models?: Record<string, unknown>[] };
  const out: DiscoveredModel[] = [];
  for (const m of tags.models ?? []) {
    const name = String(m.model ?? m.name);
    const show = (await getJson(`${root}/api/show`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: name }), signal }, provider)) as Record<string, unknown>;
    const caps = Array.isArray(show.capabilities) ? (show.capabilities as string[]) : undefined;
    const info = (show.model_info ?? {}) as Record<string, unknown>;
    const ctxKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
    const details = (m.details ?? {}) as Record<string, unknown>;
    const capabilities: Partial<ModelCapabilities> = {
      ...(caps ? { tools: caps.includes("tools"), input: caps.includes("vision") ? (["text", "image"] as const) : (["text"] as const) } : {}),
      ...(ctxKey && typeof info[ctxKey] === "number" ? { contextWindow: info[ctxKey] } : {})
    };
    out.push({
      id: name,
      capabilities,
      details: Object.fromEntries(
        [
          ["digest", m.digest],
          ["family", details.family],
          ["parameterSize", details.parameter_size],
          ["quantization", details.quantization_level]
        ].filter((e): e is [string, string] => typeof e[1] === "string")
      )
    });
  }
  return out;
}

/** OpenRouter's catalog says, per model, which parameters some upstream provider honors. */
async function openRouterModels(provider: ResolvedProvider, headers: Record<string, string>, key: string | undefined, signal: AbortSignal): Promise<DiscoveredModel[]> {
  const list = (await getJson(`${provider.baseUrl}/models`, { headers: { ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal }, provider)) as { data?: Record<string, unknown>[] };
  return (list.data ?? []).map((m) => {
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : [];
    const arch = (m.architecture ?? {}) as Record<string, unknown>;
    const modalities = Array.isArray(arch.input_modalities) ? (arch.input_modalities as string[]) : ["text"];
    const top = (m.top_provider ?? {}) as Record<string, unknown>;
    return {
      id: String(m.id),
      ...(typeof m.name === "string" ? { displayName: m.name } : {}),
      capabilities: {
        tools: params.includes("tools"),
        parallelToolCalls: params.includes("parallel_tool_calls"),
        structuredOutput: params.includes("structured_outputs") ? "schema" : params.includes("response_format") ? "json" : "none",
        seed: params.includes("seed"),
        temperature: params.includes("temperature"),
        input: modalities.includes("image") ? ["text", "image"] : ["text"],
        ...(typeof m.context_length === "number" ? { contextWindow: m.context_length } : {}),
        ...(typeof top.max_completion_tokens === "number" ? { maxOutputTokens: top.max_completion_tokens } : {})
      }
    };
  });
}
