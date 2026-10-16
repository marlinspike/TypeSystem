import { afterEach, describe, expect, it } from "vitest";
import type { JsonSchema2020 } from "@typesys/core";
import { createLlm, LlmError, type LlmConfig, type CallRecord, type ProviderKind } from "../src/index.js";
import { anthropicMessage, anthropicStream, chatCompletion, chatStream, fakeProvider, type FakeReply, type Received } from "./fake-provider.js";

/**
 * The provider layer (ADR-0074) through the real vendor SDKs against a fake
 * provider on loopback: each protocol's requests and answers, structured
 * output and its validation, tool calls, streams, and every failure a
 * provider can produce, normalized the same way.
 */
const KEY = "sk-ant-test-0123456789abcdef";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(kind: ProviderKind, handler: (r: Received, n: number) => FakeReply | Promise<FakeReply>, extra: { model?: Record<string, unknown>; provider?: Record<string, unknown> } = {}) {
  const server = await fakeProvider(handler);
  closers.push(() => server.close());
  const records: CallRecord[] = [];
  const sleeps: number[] = [];
  const config = {
    format: "typesys.llm/1",
    providers: {
      p: {
        kind,
        baseUrl: kind === "anthropic" ? server.url : `${server.url}/v1`,
        ...(kind === "anthropic" || kind === "openai" || kind === "openrouter" ? { apiKeyEnv: "TEST_KEY", environment: "hosted" } : {}),
        maxAttempts: 3,
        ...extra.provider
      }
    },
    models: { m: { provider: "p", model: "the-model", uses: ["development", "runtime"], ...extra.model } }
  } as unknown as LlmConfig;
  const llm = createLlm(config, {
    secrets: (n) => (n === "TEST_KEY" ? KEY : undefined),
    onCall: (r) => records.push(r),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5
  });
  return { llm, server, records, sleeps, model: llm.model("m", "development") };
}

const SCHEMA = { type: "object", properties: { name: { type: "string" }, count: { type: "integer", minimum: 0 } }, required: ["name", "count"], additionalProperties: false } satisfies JsonSchema2020;
const LOOSE = { type: "object", properties: { name: { type: "string" } }, required: ["name"] } satisfies JsonSchema2020;

describe("Anthropic, natively", () => {
  it("sends a Messages request and reads text, usage and the served model; hosted providers need https unless on loopback", async () => {
    const { model, server, records } = await setup("anthropic", () => ({ json: anthropicMessage([{ type: "text", text: "Hello" }]) }));
    const r = await model.generate({ system: "Be brief.", messages: [{ role: "user", content: "Hi" }], purpose: "test" });
    expect(r.text).toBe("Hello");
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    const sent = server.received[0]!;
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers["x-api-key"]).toBe(KEY);
    expect(sent.body).toMatchObject({ model: "the-model", system: "Be brief.", messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
    expect(sent.body).not.toHaveProperty("temperature");
    expect(records[0]).toMatchObject({ purpose: "test", attempts: 1, model: { id: "m", providerModel: "the-model", served: "claude-test" }, audience: "model:m" });
    expect(JSON.stringify(records)).not.toContain("Hello");
  });

  it("asks for a closed schema with output_config and validates the answer; an open schema is asked for in the instruction, and validated the same way", async () => {
    const { model, server } = await setup("anthropic", (_r, n) => ({ json: anthropicMessage([{ type: "text", text: n === 1 ? '{"name":"a","count":2}' : '{"name":"b"}' }]) }));
    const strict = await model.generate({ messages: [{ role: "user", content: "x" }], output: { schema: SCHEMA } });
    expect(strict.object).toEqual({ name: "a", count: 2 });
    expect(server.received[0]!.body.output_config).toEqual({ format: { type: "json_schema", schema: SCHEMA } });
    const loose = await model.generate({ messages: [{ role: "user", content: "x" }], output: { schema: LOOSE } });
    expect(loose.object).toEqual({ name: "b" });
    expect(server.received[1]!.body).not.toHaveProperty("output_config");
    expect(String(server.received[1]!.body.system)).toContain("JSON Schema");
  });

  it("repairs an answer that does not satisfy the schema once, by showing the model what is wrong; a second bad answer is invalid-output with the problems", async () => {
    const answers = ['{"name":"a"}', '{"name":"a","count":1}'];
    const ok = await setup("anthropic", (_r, n) => ({ json: anthropicMessage([{ type: "text", text: answers[n - 1]! }]) }));
    const r = await ok.model.generate({ messages: [{ role: "user", content: "x" }], output: { schema: SCHEMA } });
    expect(r.object).toEqual({ name: "a", count: 1 });
    expect(r.usage.inputTokens).toBe(24);
    const repair = ok.server.received[1]!.body.messages as { role: string; content: { text: string }[] }[];
    expect(repair.at(-1)!.content[0]!.text).toMatch(/must have required property 'count'/);

    const bad = await setup("anthropic", () => ({ json: anthropicMessage([{ type: "text", text: "not json at all" }]) }));
    const err = await bad.model.generate({ messages: [{ role: "user", content: "x" }], output: { schema: SCHEMA } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: "invalid-output", retryable: false, problems: ["the answer is not JSON"] });
    expect(bad.server.received).toHaveLength(2);
  });

  it("an answer cut off at the output limit is invalid-output, not repaired", async () => {
    const { model, server } = await setup("anthropic", () => ({ json: anthropicMessage([{ type: "text", text: '{"name":"a","cou' }], "max_tokens") }));
    await expect(model.generate({ messages: [{ role: "user", content: "x" }], output: { schema: SCHEMA } })).rejects.toMatchObject({ code: "invalid-output" });
    expect(server.received).toHaveLength(1);
  });

  it("reads tool calls, echoes thinking blocks back on the next turn, and sends tool results as one user turn", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const { model, server } = await setup("anthropic", (_r, n) =>
      n === 1
        ? { json: anthropicMessage([thinking, { type: "tool_use", id: "tu_1", name: "lookup", input: { id: "A" } }, { type: "tool_use", id: "tu_2", name: "lookup", input: { id: "B" } }], "tool_use") }
        : { json: anthropicMessage([{ type: "text", text: "done" }]) }
    );
    const tools = [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }];
    const first = await model.generate({ messages: [{ role: "user", content: "go" }], tools });
    expect(first.finishReason).toBe("tool-calls");
    expect(first.toolCalls).toEqual([
      { id: "tu_1", name: "lookup", input: { id: "A" } },
      { id: "tu_2", name: "lookup", input: { id: "B" } }
    ]);
    await model.generate({
      messages: [
        { role: "user", content: "go" },
        first.message,
        { role: "tool", toolCallId: "tu_1", name: "lookup", content: "1" },
        { role: "tool", toolCallId: "tu_2", name: "lookup", content: "2" }
      ],
      tools
    });
    const msgs = server.received[1]!.body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(msgs).toHaveLength(3);
    expect(msgs[1]!.content[0]).toEqual(thinking);
    expect(msgs[2]!.content.map((b) => b.tool_use_id)).toEqual(["tu_1", "tu_2"]);
  });

  it("streams text as it arrives and finishes with usage; a stream cut before it finished is retried while nothing was delivered", async () => {
    const { model } = await setup("anthropic", () => ({ sse: anthropicStream(["Hel", "lo"]), named: true }));
    const s = model.stream({ messages: [{ role: "user", content: "Hi" }] });
    const texts: string[] = [];
    for await (const e of s) if (e.type === "text") texts.push(e.text);
    expect(texts).toEqual(["Hel", "lo"]);
    const r = await s.result;
    expect(r).toMatchObject({ text: "Hello", usage: { inputTokens: 10, outputTokens: 9 } });
    expect(r.record.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);

    const cut = await setup("anthropic", (_r, n) => (n === 1 ? { sse: anthropicStream(["x"]), named: true, cutAfter: 1 } : { sse: anthropicStream(["ok"]), named: true }));
    const s2 = cut.model.stream({ messages: [{ role: "user", content: "Hi" }] });
    expect((await s2.result).text).toBe("ok");
    expect(cut.server.received).toHaveLength(2);
  });

  it("a stream that fails after delivering text fails, and is not sent again", async () => {
    const { model, server } = await setup("anthropic", () => ({ sse: anthropicStream(["partial", "rest"]), named: true, cutAfter: 3 }));
    const s = model.stream({ messages: [{ role: "user", content: "Hi" }] });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const e of s) if (e.type === "text") seen.push(e.text);
      })()
    ).rejects.toMatchObject({ code: "unavailable", retryable: false });
    expect(seen).toEqual(["partial"]);
    expect(server.received).toHaveLength(1);
  });

  it("rate limits are retried after the provider's retry-after; authentication fails at once with no key in the message", async () => {
    const limited = await setup("anthropic", (_r, n) => (n === 1 ? { status: 429, json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, headers: { "retry-after": "2" } } : { json: anthropicMessage([{ type: "text", text: "ok" }]) }));
    const r = await limited.model.generate({ messages: [{ role: "user", content: "x" }] });
    expect(r.text).toBe("ok");
    expect(limited.sleeps).toEqual([2000]);
    expect(r.record.attempts).toBe(2);

    const denied = await setup("anthropic", () => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${KEY}` } } }));
    const err = (await denied.model.generate({ messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e)) as LlmError;
    expect(err).toMatchObject({ code: "authentication", retryable: false, status: 401, model: "m" });
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(denied.records)).not.toContain(KEY);
    expect(denied.server.received).toHaveLength(1);
  });

  it("an overloaded provider is retried with backoff, then reported as overloaded", async () => {
    const { model, sleeps, server } = await setup("anthropic", () => ({ status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }));
    await expect(model.generate({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "overloaded", retryable: true });
    expect(server.received).toHaveLength(3);
    expect(sleeps).toEqual([375, 750]);
  });

  it("lists models with what the provider says of each", async () => {
    const { llm } = await setup("anthropic", (r) =>
      r.path === "/v1/models"
        ? { json: { data: [{ id: "the-model", type: "model", display_name: "The Model", created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: { structured_outputs: { supported: true }, image_input: { supported: true } } }], has_more: false, first_id: "the-model", last_id: "the-model" } }
        : { status: 404, json: {} }
    );
    expect(await llm.discover("p")).toEqual([{ id: "the-model", displayName: "The Model", capabilities: { contextWindow: 1000000, maxOutputTokens: 128000, structuredOutput: "schema", input: ["text", "image"] } }]);
  });
});

describe("the Chat Completions protocol: OpenAI and compatible servers", () => {
  it("OpenAI caps output with max_completion_tokens and asks for a closed schema strictly; Ollama uses max_tokens and json_schema", async () => {
    const openai = await setup("openai", () => ({ json: chatCompletion({ content: '{"name":"a","count":1}' }) }));
    await openai.model.generate({ messages: [{ role: "user", content: "x" }], output: { schema: SCHEMA }, maxOutputTokens: 100, seed: 7, temperature: 0 });
    expect(openai.server.received[0]!.body).toMatchObject({ max_completion_tokens: 100, seed: 7, temperature: 0, response_format: { type: "json_schema", json_schema: { name: "answer", schema: SCHEMA, strict: true } } });
    expect(openai.server.received[0]!.headers.authorization).toBe(`Bearer ${KEY}`);

    const ollama = await setup("ollama", () => ({ json: chatCompletion({ content: '{"name":"b"}' }) }));
    const r = await ollama.model.generate({ messages: [{ role: "user", content: "x" }], output: { schema: LOOSE }, maxOutputTokens: 50 });
    expect(r.object).toEqual({ name: "b" });
    expect(ollama.server.received[0]!.body).toMatchObject({ max_tokens: 50, response_format: { type: "json_schema", json_schema: { schema: LOOSE, strict: false } } });
    expect(ollama.server.received[0]!.body).not.toHaveProperty("max_completion_tokens");
    expect(ollama.llm.models()[0]!.provider.environment).toBe("local");
  });

  it("OpenAI asks for an open schema as JSON mode with the schema in the instruction", async () => {
    const { model, server } = await setup("openai", () => ({ json: chatCompletion({ content: '{"name":"a"}' }) }));
    await model.generate({ messages: [{ role: "user", content: "x" }], output: { schema: LOOSE } });
    expect(server.received[0]!.body.response_format).toEqual({ type: "json_object" });
    expect((server.received[0]!.body.messages as { content: string }[])[0]!.content).toContain("JSON Schema");
  });

  it("OpenRouter is kept to upstream providers that honor every parameter", async () => {
    const { model, server } = await setup("openrouter", () => ({ json: chatCompletion({ content: "hi" }) }));
    await model.generate({ messages: [{ role: "user", content: "x" }] });
    expect(server.received[0]!.body.provider).toEqual({ require_parameters: true });
  });

  it("tool calls are parsed; arguments that are not JSON are a malformed answer, retried", async () => {
    const call = (args: string) => ({ json: chatCompletion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: args } }] }, "tool_calls") });
    const { model, server } = await setup("vllm", (_r, n) => (n === 1 ? call("{bad") : call('{"id":"A"}')), { model: { capabilities: { tools: true } } });
    const r = await model.generate({ messages: [{ role: "user", content: "x" }], tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }], toolChoice: "required" });
    expect(r.toolCalls).toEqual([{ id: "c1", name: "lookup", input: { id: "A" } }]);
    expect(server.received).toHaveLength(2);
    expect(server.received[0]!.body.tool_choice).toBe("required");
  });

  it("streams text and tool-call deltas, with usage from the last chunk", async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
    const { model, server } = await setup("lmstudio", () => ({
      sse: [
        chunk({ role: "assistant", content: "Look" }),
        chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "lookup", arguments: '{"id":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"A"}' } }] }),
        chunk({}, "tool_calls"),
        { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
        "[DONE]"
      ]
    }), { model: { capabilities: { tools: true } } });
    const s = model.stream({ messages: [{ role: "user", content: "x" }], tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }] });
    const events: string[] = [];
    for await (const e of s) events.push(e.type === "text" ? `text:${e.text}` : e.type === "tool-call" ? `call:${e.call.name}:${JSON.stringify(e.call.input)}` : e.type);
    expect(events).toEqual(["text:Look", 'call:lookup:{"id":"A"}', "finish"]);
    expect((await s.result).usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(server.received[0]!.body.stream_options).toEqual({ include_usage: true });
  });

  it("a compatible server that reports no usage gets usage estimated, and says so", async () => {
    const { model, llm } = await setup("openai-compatible", () => ({ json: chatCompletion({ content: "a fairly short answer" }, "stop", null) }), { provider: { environment: "private" } });
    const r = await model.generate({ messages: [{ role: "user", content: "x" }] });
    expect(r.usage.estimated).toBe(true);
    expect(llm.usage.totals().estimatedCalls).toBe(1);
  });

  it("a stream with no finish is malformed and retried; a server that is down is unavailable", async () => {
    const { model, server } = await setup("ollama", (_r, n) => (n === 1 ? { sse: chatStream(["a"]).slice(0, 1) } : { sse: chatStream(["b"]) }));
    expect((await model.stream({ messages: [{ role: "user", content: "x" }] }).result).text).toBe("b");
    expect(server.received).toHaveLength(2);

    const down = createLlm({ format: "typesys.llm/1", providers: { o: { kind: "ollama", baseUrl: "http://127.0.0.1:9/v1", maxAttempts: 1 } }, models: { m: { provider: "o", model: "x", uses: ["development"] } } });
    await expect(down.model("m", "development").generate({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "unavailable", model: "m" });
  });

  it("discovers Ollama models with their capabilities and context length from its own API, and validation names a capability the configuration overstates", async () => {
    const { llm } = await setup(
      "ollama",
      (r) =>
        r.path === "/api/tags"
          ? { json: { models: [{ name: "the-model", model: "the-model", digest: "abc123", details: { family: "qwen2", parameter_size: "7.6B", quantization_level: "Q4_K_M" } }] } }
          : r.path === "/api/show"
            ? { json: { capabilities: ["completion"], model_info: { "qwen2.context_length": 32768 } } }
            : { status: 404, json: {} },
      { model: { capabilities: { tools: true } } }
    );
    expect(await llm.discover("p")).toEqual([{ id: "the-model", capabilities: { tools: false, input: ["text"], contextWindow: 32768 }, details: { digest: "abc123", family: "qwen2", parameterSize: "7.6B", quantization: "Q4_K_M" } }]);
    expect(await llm.validate()).toEqual([expect.objectContaining({ code: "capability-contradicted", at: "models/m/capabilities/tools" })]);
  });
});

describe("what is decided before anything is sent", () => {
  it("a request needing a capability the model does not declare fails with unsupported-capability and sends nothing", async () => {
    const { model, server, records } = await setup("ollama", () => ({ json: chatCompletion({ content: "x" }) }));
    await expect(model.generate({ messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "AAAA" }] }] })).rejects.toMatchObject({ code: "unsupported-capability", message: "Model m does not support image input" });
    await expect(model.generate({ messages: [{ role: "user", content: "x" }], tools: [{ name: "t", description: "d", inputSchema: {} }] })).rejects.toMatchObject({ code: "unsupported-capability" });
    expect(server.received).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it("a timeout and a caller's cancellation are told apart, and neither is retried past the deadline", async () => {
    const { model } = await setup("ollama", () => ({ json: chatCompletion({ content: "late" }), delayMs: 400 }));
    await expect(model.generate({ messages: [{ role: "user", content: "x" }] }, { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(model.generate({ messages: [{ role: "user", content: "x" }] }, { signal: ac.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("a model is used only for what it is configured for", async () => {
    const { llm } = await setup("ollama", () => ({ json: chatCompletion({ content: "x" }) }), { model: { uses: ["development"] } });
    expect(() => llm.model("m", "runtime")).toThrow(/not configured for runtime use/);
  });

  it("a missing credential is a configuration error that names the variable, not a key", async () => {
    const llm = createLlm({ format: "typesys.llm/1", providers: { a: { kind: "anthropic" } }, models: { m: { provider: "a", model: "x", uses: ["development"] } } }, { secrets: () => undefined });
    expect(llm.diagnostics).toContainEqual(expect.objectContaining({ code: "missing-credential", message: "ANTHROPIC_API_KEY is not set; calls to a will fail" }));
    await expect(llm.model("m", "development").generate({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "configuration", message: "Provider a needs ANTHROPIC_API_KEY set" });
  });
});
