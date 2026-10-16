import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { canonical } from "@typesys/core";
import { createHash, randomUUID } from "node:crypto";
import type { ResolvedModel } from "./config.js";
import { LlmError } from "./errors.js";
import { decideRelease } from "./release.js";
import { extractJson, strictCompatible, type OutputValidator } from "./structured.js";
import type {
  AdapterRequest,
  CallOptions,
  CallRecord,
  CapabilityRequirement,
  Cost,
  GenerateRequest,
  GenerateResult,
  Message,
  ModelCapabilities,
  ProviderAdapter,
  ProviderResponse,
  StreamEvent,
  Usage
} from "./types.js";
import type { ClassificationScheme } from "@typesys/core";

/** One configured model, ready to call: capabilities checked, release decided, output validated, every call accounted. */
export interface LanguageModel {
  readonly id: string;
  readonly info: ResolvedModel;
  generate(request: GenerateRequest, options?: CallOptions): Promise<GenerateResult>;
  /** Text as it arrives, then the whole result; `result` settles with the same result or error. */
  stream(request: GenerateRequest, options?: CallOptions): ModelStream;
}

export interface ModelStream extends AsyncIterable<StreamEvent> {
  readonly result: Promise<GenerateResult>;
}

/** What every model of one `Llm` shares. */
export interface ModelEnvironment {
  adapter(model: ResolvedModel): Promise<ProviderAdapter>;
  readonly validator: OutputValidator;
  readonly scheme?: ClassificationScheme;
  readonly requireLabels: boolean;
  /** Called with every call's record, failed ones too. Content is never in it. */
  record(record: CallRecord): void;
  readonly now: () => Date;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random: () => number;
  /** Attempts at repairing an answer that does not satisfy the schema, by showing the model what is wrong. Default 1. */
  readonly repairAttempts: number;
}

const tracer = trace.getTracer("@typesys/llm");
const digest = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : canonical(v)).digest("hex");

/** The capabilities `request` needs of a model. */
export function requirementsOf(request: GenerateRequest): CapabilityRequirement[] {
  const out: CapabilityRequirement[] = [];
  if (request.tools?.length) out.push({ capability: "tools" });
  if (request.system !== undefined) out.push({ capability: "systemPrompt" });
  if (request.temperature !== undefined) out.push({ capability: "temperature" });
  if (request.seed !== undefined) out.push({ capability: "seed" });
  if (request.messages.some((m) => m.role === "user" && typeof m.content !== "string" && m.content.some((p) => p.type === "image"))) out.push({ capability: "input", kind: "image" });
  if (request.maxOutputTokens !== undefined) out.push({ capability: "maxOutputTokens", atLeast: request.maxOutputTokens });
  return out;
}

const STRUCTURED_RANK = { none: 0, json: 1, schema: 2 } as const;

/** Why `capabilities` cannot meet `need`, or undefined when they can. */
export function unmet(capabilities: ModelCapabilities, need: CapabilityRequirement): string | undefined {
  switch (need.capability) {
    case "input":
      return capabilities.input.includes(need.kind) ? undefined : `${need.kind} input`;
    case "structuredOutput":
      return STRUCTURED_RANK[capabilities.structuredOutput] >= STRUCTURED_RANK[need.atLeast] ? undefined : `structured output (${need.atLeast})`;
    case "contextWindow":
      return capabilities.contextWindow === undefined || capabilities.contextWindow >= need.atLeast ? undefined : `a context window of ${need.atLeast} tokens`;
    case "maxOutputTokens":
      return capabilities.maxOutputTokens === undefined || capabilities.maxOutputTokens >= need.atLeast ? undefined : `${need.atLeast} output tokens`;
    default:
      return capabilities[need.capability] ? undefined : `${need.capability}`;
  }
}

/**
 * The structured-output mode to ask for: the provider's schema enforcement
 * when the model declares it and the schema fits it (Anthropic and OpenAI
 * enforce only closed, all-required schemas), else JSON mode where the
 * protocol has one, else the instruction alone. The answer is validated
 * the same way whichever is used.
 */
function structuredMode(model: ResolvedModel, request: GenerateRequest): AdapterRequest["structured"] {
  if (!request.output) return undefined;
  const declared = model.capabilities.structuredOutput;
  const strictOnly = model.provider.kind === "anthropic" || model.provider.kind === "openai";
  if (declared === "schema" && (!strictOnly || strictCompatible(request.output.schema))) return "schema";
  if (declared === "none" || model.provider.kind === "anthropic") return "none";
  return "json";
}

function costOf(model: ResolvedModel, usage: Usage): Cost | undefined {
  const p = model.pricing;
  if (!p) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = usage.inputTokens - cached;
  const amount = (uncached * p.inputPerMillion + cached * (p.cachedInputPerMillion ?? p.inputPerMillion) + usage.outputTokens * p.outputPerMillion) / 1_000_000;
  return { amount: Math.round(amount * 1e8) / 1e8, currency: "USD", basis: "configured" };
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  ...((a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) > 0 ? { cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) } : {}),
  ...(a.estimated || b.estimated ? { estimated: true } : {})
});

/** A configured model behind its adapter (ADR-0074). */
export class ManagedModel implements LanguageModel {
  readonly id: string;

  constructor(
    readonly info: ResolvedModel,
    private readonly env: ModelEnvironment
  ) {
    this.id = info.id;
  }

  /**
   * Everything decided before anything is sent: the model can do what is
   * asked, and the content may go to it. Throws `unsupported-capability` or
   * `release-refused`.
   */
  admit(request: GenerateRequest, streaming = false): void {
    const needs = requirementsOf(request);
    if (streaming) needs.push({ capability: "streaming" });
    const missing = needs.map((n) => unmet(this.info.capabilities, n)).filter((m): m is string => m !== undefined);
    if (missing.length > 0) throw new LlmError("unsupported-capability", `Model ${this.id} does not support ${missing.join(", ")}`, { model: this.id, provider: this.info.provider.name });
    const release = decideRelease(this.env.scheme, this.info.audience, request.label, this.env.requireLabels);
    if (!release.allow) {
      // The reason may name markings: it goes to the record, and the caller is told only that it was refused.
      this.env.record(this.failedRecord(request, "release-refused", release.reason ?? "refused"));
      throw new LlmError("release-refused", `The request may not be sent to model ${this.id}`, { model: this.id, provider: this.info.provider.name });
    }
    if (request.releasedFor !== undefined && request.releasedFor !== this.info.audience.id) {
      this.env.record(this.failedRecord(request, "release-refused", `the content was read for audience ${request.releasedFor}, not ${this.info.audience.id}`));
      throw new LlmError("release-refused", `The request may not be sent to model ${this.id}`, { model: this.id, provider: this.info.provider.name });
    }
  }

  private adapterRequest(request: GenerateRequest): AdapterRequest {
    const d = this.info.defaults;
    const structured = structuredMode(this.info, request);
    // Which audience the content was read for decides who may receive it, not what is sent: it is not part of the request a provider (or a recording) sees.
    const { releasedFor: _releasedFor, ...sent } = request;
    return {
      ...sent,
      ...(request.temperature === undefined && d.temperature !== undefined && this.info.capabilities.temperature ? { temperature: d.temperature } : {}),
      ...(request.seed === undefined && d.seed !== undefined && this.info.capabilities.seed ? { seed: d.seed } : {}),
      maxOutputTokens: request.maxOutputTokens ?? d.maxOutputTokens ?? Math.min(this.info.capabilities.maxOutputTokens ?? 8192, 8192),
      ...(structured ? { structured } : {})
    };
  }

  private baseRecord(request: GenerateRequest, at: Date, adapterRequest?: AdapterRequest): Omit<CallRecord, "attempts" | "latencyMs"> {
    const r = adapterRequest ?? request;
    return {
      callId: randomUUID(),
      at: at.toISOString(),
      ...(request.purpose ? { purpose: request.purpose } : {}),
      model: { id: this.id, provider: this.info.provider.name, providerModel: this.info.model, ...(this.info.version ? { version: this.info.version } : {}) },
      audience: this.info.audience.id,
      configDigest: this.info.configDigest,
      requestDigest: digest({ ...request, label: undefined, purpose: undefined, releasedFor: undefined }),
      parameters: {
        ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
        ...(r.seed !== undefined ? { seed: r.seed } : {}),
        ...(r.maxOutputTokens !== undefined ? { maxOutputTokens: r.maxOutputTokens } : {}),
        ...((r as AdapterRequest).structured ? { structured: (r as AdapterRequest).structured } : {})
      }
    };
  }

  private failedRecord(request: GenerateRequest, code: string, message: string): CallRecord {
    return { ...this.baseRecord(request, this.env.now()), attempts: 0, latencyMs: 0, error: { code, message } };
  }

  /** A signal that aborts on the caller's signal or the deadline, and says which. */
  private deadline(options: CallOptions | undefined): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = options?.timeoutMs ?? this.info.provider.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new LlmError("timeout", `Model ${this.id} did not answer within ${timeoutMs} ms`, { model: this.id }));
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(new LlmError("cancelled", `The call to model ${this.id} was cancelled`, { model: this.id }));
    if (options?.signal?.aborted) onAbort();
    else options?.signal?.addEventListener("abort", onAbort, { once: true });
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      done: () => {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
      }
    };
  }

  /** The adapter's error with this model's id, or the abort that caused it. */
  private normalize(err: unknown, signal: AbortSignal, timedOut: () => boolean): LlmError {
    if (signal.aborted) return timedOut() ? new LlmError("timeout", `Model ${this.id} did not answer in time`, { model: this.id, provider: this.info.provider.name }) : new LlmError("cancelled", `The call to model ${this.id} was cancelled`, { model: this.id, provider: this.info.provider.name });
    if (err instanceof LlmError) {
      if (err.model) return err;
      const e = new LlmError(err.code, err.message, {
        model: this.id,
        provider: err.provider ?? this.info.provider.name,
        retryable: err.retryable,
        ...(err.status !== undefined ? { status: err.status } : {}),
        ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
        ...(err.problems ? { problems: err.problems } : {})
      });
      return e;
    }
    return new LlmError("unavailable", `Model ${this.id} failed`, { model: this.id, provider: this.info.provider.name, cause: err });
  }

  /** One provider call, retried while the error is retryable, attempts remain and the deadline allows. */
  private async withRetries<T>(signal: AbortSignal, timedOut: () => boolean, options: CallOptions | undefined, attempt: (n: number) => Promise<T>): Promise<{ value: T; attempts: number }> {
    const max = options?.maxAttempts ?? this.info.provider.maxAttempts;
    for (let n = 1; ; n++) {
      try {
        return { value: await attempt(n), attempts: n };
      } catch (raw) {
        const err = this.normalize(raw, signal, timedOut);
        if (!err.retryable || n >= max || signal.aborted) throw Object.assign(err, { attempts: n });
        const backoff = Math.min(20_000, 500 * 2 ** (n - 1)) * (0.5 + this.env.random() / 2);
        await this.env.sleep(err.retryAfterMs ?? backoff, signal).catch(() => undefined);
        if (signal.aborted) throw Object.assign(this.normalize(raw, signal, timedOut), { attempts: n });
      }
    }
  }

  async generate(request: GenerateRequest, options?: CallOptions): Promise<GenerateResult> {
    this.admit(request);
    return tracer.startActiveSpan(`chat ${this.info.model}`, async (span) => {
      const started = this.env.now();
      const t0 = performance.now();
      const { signal, timedOut, done } = this.deadline(options);
      const adapter = await this.adapterOrFail(request, started);
      let messages: readonly Message[] = request.messages;
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let attempts = 0;
      let ar = this.adapterRequest(request);
      let base = this.baseRecord(request, started, ar);
      try {
        for (let repair = 0; ; repair++) {
          if (repair > 0) {
            ar = this.adapterRequest({ ...request, messages });
            base = this.baseRecord(request, started, ar);
          }
          const { value: response, attempts: n } = await this.withRetries(signal, timedOut, options, () => adapter.generate(this.info.model, ar, signal));
          attempts += n;
          usage = addUsage(usage, response.usage);
          const checked = this.check(request, response);
          if (checked.ok) {
            const cost = costOf(this.info, usage);
            const record: CallRecord = {
              ...base,
              model: { ...base.model, ...(response.served ? { served: response.served } : {}) },
              attempts,
              finishReason: response.finishReason,
              usage,
              ...(cost ? { cost } : {}),
              latencyMs: Math.round(performance.now() - t0),
              responseDigest: digest({ text: response.text, toolCalls: response.toolCalls })
            };
            this.finishSpan(span, record);
            this.env.record(record);
            return this.result(response, checked.object, usage, cost, record, request);
          }
          if (repair >= this.env.repairAttempts || !checked.repairable) throw new LlmError("invalid-output", `Model ${this.id}'s answer does not satisfy the requested schema`, { model: this.id, provider: this.info.provider.name, problems: checked.problems, retryable: false });
          // Show the model its answer and what is wrong with it, once more.
          messages = [
            ...messages,
            { role: "assistant", content: response.text },
            { role: "user", content: `That answer does not satisfy the schema:\n- ${checked.problems.join("\n- ")}\nAnswer again with only the corrected JSON.` }
          ];
        }
      } catch (raw) {
        const err = raw instanceof LlmError ? raw : this.normalize(raw, signal, timedOut);
        const record: CallRecord = { ...base, attempts: attempts + ((raw as { attempts?: number }).attempts ?? 0), latencyMs: Math.round(performance.now() - t0), ...(usage.inputTokens + usage.outputTokens > 0 ? { usage } : {}), error: { code: err.code, message: err.message } };
        this.finishSpan(span, record, err);
        this.env.record(record);
        throw err;
      } finally {
        done();
        span.end();
      }
    });
  }

  private async adapterOrFail(request: GenerateRequest, at: Date): Promise<ProviderAdapter> {
    try {
      return await this.env.adapter(this.info);
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError("configuration", `Model ${this.id}'s provider could not be set up`, { model: this.id, cause: err });
      this.env.record({ ...this.baseRecord(request, at), attempts: 0, latencyMs: 0, error: { code: e.code, message: e.message } });
      throw e;
    }
  }

  /** Whether the answer is what was asked for: refused, cut short, missing a required tool call, or not valid against the schema. */
  private check(request: GenerateRequest, r: ProviderResponse): { ok: true; object?: unknown } | { ok: false; problems: string[]; repairable: boolean } {
    if (r.finishReason === "refusal" || r.finishReason === "content-filter") throw new LlmError("refused", `Model ${this.id} declined to answer`, { model: this.id, provider: this.info.provider.name });
    if (request.toolChoice === "required" && r.toolCalls.length === 0) {
      if (r.finishReason === "length") throw new LlmError("invalid-output", `Model ${this.id}'s answer was cut off at the output limit before it called a tool`, { model: this.id, retryable: false });
      return { ok: false, problems: ["the answer calls no tool, and one must be called"], repairable: false };
    }
    if (!request.output || r.toolCalls.length > 0) return { ok: true };
    if (r.finishReason === "length") throw new LlmError("invalid-output", `Model ${this.id}'s answer was cut off at the output limit`, { model: this.id, problems: ["the answer is incomplete: raise maxOutputTokens"], retryable: false });
    const parsed = extractJson(r.text);
    if (!parsed.ok) return { ok: false, problems: [parsed.problem], repairable: true };
    const problems = this.env.validator.problems(request.output.schema, parsed.value);
    return problems.length === 0 ? { ok: true, object: parsed.value } : { ok: false, problems, repairable: true };
  }

  private result(r: ProviderResponse, object: unknown, usage: Usage, cost: Cost | undefined, record: CallRecord, request: GenerateRequest): GenerateResult {
    return {
      text: r.text,
      toolCalls: r.toolCalls,
      ...(request.output && r.toolCalls.length === 0 ? { object } : {}),
      finishReason: r.finishReason,
      usage,
      ...(cost ? { cost } : {}),
      record,
      message: { role: "assistant", content: r.text, ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}), ...(r.opaque ? { opaque: r.opaque } : {}) }
    };
  }

  private finishSpan(span: Span, record: CallRecord, err?: LlmError): void {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": this.info.provider.kind,
      "gen_ai.request.model": this.info.model,
      ...(record.model.served ? { "gen_ai.response.model": record.model.served } : {}),
      ...(record.usage ? { "gen_ai.usage.input_tokens": record.usage.inputTokens, "gen_ai.usage.output_tokens": record.usage.outputTokens } : {}),
      ...(record.parameters.temperature !== undefined ? { "gen_ai.request.temperature": record.parameters.temperature } : {}),
      ...(record.parameters.maxOutputTokens !== undefined ? { "gen_ai.request.max_tokens": record.parameters.maxOutputTokens } : {}),
      ...(record.finishReason ? { "gen_ai.response.finish_reasons": [record.finishReason] } : {}),
      "typesys.llm.model_id": this.id,
      "typesys.llm.audience": this.info.audience.id,
      "typesys.llm.environment": this.info.provider.environment,
      "typesys.llm.attempts": record.attempts,
      ...(record.purpose ? { "typesys.llm.purpose": record.purpose } : {}),
      ...(record.cost ? { "typesys.llm.cost_usd": record.cost.amount } : {})
    });
    if (err) {
      span.setAttribute("error.type", err.code);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.code });
    }
  }

  stream(request: GenerateRequest, options?: CallOptions): ModelStream {
    const events: StreamEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;
    const push = (e: StreamEvent) => {
      events.push(e);
      wake?.();
    };
    const result = this.runStream(request, options, push).then(
      (r) => {
        finished = true;
        wake?.();
        return r;
      },
      (err: unknown) => {
        failure = err instanceof Error ? err : new Error(String(err));
        finished = true;
        wake?.();
        throw err;
      }
    );
    // Observed by the iterator; a caller that only awaits `result` handles it there.
    result.catch(() => undefined);
    return {
      result,
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (events.length > 0) {
            yield events.shift()!;
            continue;
          }
          if (finished) {
            if (failure !== undefined) throw failure;
            return;
          }
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      }
    };
  }

  /**
   * One streamed call. A failure before anything was delivered is retried
   * like any other; after text has been delivered it is not, since the
   * caller has already seen it. A structured answer is validated when the
   * stream finishes, without repair.
   */
  private async runStream(request: GenerateRequest, options: CallOptions | undefined, push: (e: StreamEvent) => void): Promise<GenerateResult> {
    this.admit(request, true);
    const started = this.env.now();
    const t0 = performance.now();
    const { signal, timedOut, done } = this.deadline(options);
    const span = tracer.startSpan(`chat ${this.info.model}`);
    const adapter = await this.adapterOrFail(request, started);
    const ar = this.adapterRequest(request);
    const base = this.baseRecord(request, started, ar);
    let delivered = false;
    let firstToken: number | undefined;
    let attempts = 0;
    try {
      const { value: response, attempts: n } = await this.withRetries(signal, timedOut, delivered ? { ...options, maxAttempts: 1 } : options, async () => {
        attempts++;
        if (delivered) throw new LlmError("malformed-response", "The stream failed after delivering text", { model: this.id, retryable: false });
        let done_: ProviderResponse | undefined;
        try {
          for await (const e of adapter.stream(this.info.model, ar, signal)) {
            if (e.type === "text") {
              delivered = true;
              firstToken ??= performance.now() - t0;
              push({ type: "text", text: e.text });
            } else done_ = e.response;
          }
        } catch (err) {
          // Text already delivered cannot be taken back: the failure is final.
          if (delivered) throw Object.assign(this.normalize(err, signal, timedOut), { retryable: false });
          throw err;
        }
        if (!done_) throw new LlmError("malformed-response", "The stream ended without an answer", { model: this.id });
        return done_;
      });
      attempts = Math.max(attempts, n);
      const checked = this.check(request, response);
      if (!checked.ok) throw new LlmError("invalid-output", `Model ${this.id}'s answer does not satisfy the requested schema`, { model: this.id, problems: checked.problems, retryable: false });
      for (const call of response.toolCalls) push({ type: "tool-call", call });
      const cost = costOf(this.info, response.usage);
      const record: CallRecord = {
        ...base,
        model: { ...base.model, ...(response.served ? { served: response.served } : {}) },
        attempts,
        finishReason: response.finishReason,
        usage: response.usage,
        ...(cost ? { cost } : {}),
        latencyMs: Math.round(performance.now() - t0),
        ...(firstToken !== undefined ? { timeToFirstTokenMs: Math.round(firstToken) } : {}),
        responseDigest: digest({ text: response.text, toolCalls: response.toolCalls })
      };
      this.finishSpan(span, record);
      this.env.record(record);
      const result = this.result(response, checked.object, response.usage, cost, record, request);
      push({ type: "finish", result });
      return result;
    } catch (raw) {
      const err = raw instanceof LlmError ? raw : this.normalize(raw, signal, timedOut);
      const record: CallRecord = { ...base, attempts, latencyMs: Math.round(performance.now() - t0), error: { code: err.code, message: err.message } };
      this.finishSpan(span, record, err);
      this.env.record(record);
      throw err;
    } finally {
      done();
      span.end();
    }
  }
}
