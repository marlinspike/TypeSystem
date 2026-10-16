import type { ClassificationScheme } from "@typesys/core";
import { resolveConfig, withinBoundary, type ConfigDiagnostic, type Environment, type LlmConfig, type ModelUse, type ResolvedConfig, type ResolvedModel } from "./config.js";
import { LlmError } from "./errors.js";
import { ManagedModel, unmet, requirementsOf, type LanguageModel, type ModelEnvironment, type ModelStream } from "./model.js";
import { anthropicAdapter } from "./providers/anthropic.js";
import { openAiChatAdapter } from "./providers/openai-chat.js";
import { environmentSecrets, type Secrets } from "./providers/shared.js";
import { decideRelease } from "./release.js";
import { OutputValidator } from "./structured.js";
import type { CallOptions, CallRecord, CapabilityRequirement, ContentLabel, DiscoveredModel, GenerateRequest, GenerateResult, ModelCapabilities, ProviderAdapter } from "./types.js";
import { UsageMeter } from "./usage.js";

export interface LlmOptions {
  /** Where credentials are read from. Default: the process environment. */
  readonly secrets?: Secrets;
  /** Decides labeled content against each model's audience (ADR-0075); the runtime's scheme, normally. */
  readonly classification?: ClassificationScheme;
  /** Refuse any request that carries no label. Recommended wherever governed data may reach a prompt. */
  readonly requireLabels?: boolean;
  /** Adapters by provider name: a `custom` provider's protocol, or a test double for any provider. */
  readonly adapters?: Readonly<Record<string, ProviderAdapter>>;
  /** Every call's record, failures and refusals included; never content. */
  readonly onCall?: (record: CallRecord) => void;
  /** Repair attempts for an answer that does not satisfy its schema. Default 1. */
  readonly repairAttempts?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

/** What a caller needs of a model, for selection (ADR-0075). Explicit selection is `llm.model(id)`; this picks among the configured ones. */
export interface ModelRequirements {
  readonly use: ModelUse;
  readonly capabilities?: readonly CapabilityRequirement[];
  readonly minQuality?: "basic" | "standard" | "advanced";
  /** Only models running in these environments. */
  readonly environments?: readonly Environment[];
  /** Only models whose operator-declared retention is one of these. */
  readonly retention?: readonly ("none" | "zero-data-retention" | "provider-default" | "unknown")[];
  /** Only models this content may be released to. */
  readonly label?: ContentLabel;
  /** Ceiling on the configured output price per million tokens. A model with no configured price is assumed free only if local. */
  readonly maxOutputPricePerMillion?: number;
  /** Among qualifying models: the best, the cheapest, or the most contained first. Default `quality`. */
  readonly prefer?: "quality" | "cost" | "containment";
}

/** A model that qualified, and every model that did not with the reason. */
export interface Selection {
  readonly model: LanguageModel;
  readonly considered: readonly { readonly id: string; readonly rejected?: string }[];
}

/** One recorded fallback: what failed, what answered instead. */
export interface FallbackEvent {
  readonly from: string;
  readonly to: string;
  readonly code: string;
}

export interface Llm {
  readonly config: ResolvedConfig;
  readonly diagnostics: readonly ConfigDiagnostic[];
  readonly usage: UsageMeter;
  /** Every configured model id, with what it is configured for. */
  models(): readonly ResolvedModel[];
  /**
   * A configured model by id, for `use`. With `fallback` (the default), a
   * call that fails because the model is unavailable is tried on its
   * configured fallbacks, each admitted on its own (ADR-0075).
   */
  model(id: string, use: ModelUse, options?: { readonly fallback?: boolean }): LanguageModel;
  /** The configured default for `use`. */
  defaultModel(use: ModelUse): LanguageModel;
  /** The best configured model meeting `requirements`, or `unsupported-capability` naming why each was rejected. */
  select(requirements: ModelRequirements): Selection;
  /** What a provider says it serves. Needs the provider reachable. */
  discover(provider: string, options?: { readonly signal?: AbortSignal }): Promise<DiscoveredModel[]>;
  /** Each configured model compared with what its provider reports: missing models, and declared capabilities the provider contradicts. */
  validate(options?: { readonly signal?: AbortSignal; readonly providers?: readonly string[] }): Promise<ConfigDiagnostic[]>;
  /** Fallbacks taken so far. */
  readonly fallbacks: readonly FallbackEvent[];
}

const QUALITY = { basic: 0, standard: 1, advanced: 2 } as const;
const CONTAINMENT = { local: 0, private: 1, hosted: 2 } as const;
/** Codes after which another model may answer: the model could not, not the request was wrong. */
const FALLBACK_CODES = new Set(["unavailable", "overloaded", "rate-limited", "timeout"]);

const asError = (reason: unknown): Error => (reason instanceof Error ? reason : new Error(String(reason)));

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(asError(signal.reason));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(asError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * The language models a deployment configures (ADR-0074, ADR-0075). The
 * governed runtime does not depend on it: an `Llm` is created only where
 * intelligence is wanted, and everything works without one.
 */
export function createLlm(config: LlmConfig, options: LlmOptions = {}): Llm {
  const secrets = options.secrets ?? environmentSecrets;
  const resolved = resolveConfig(config, secrets);
  const usage = new UsageMeter();
  const fallbacks: FallbackEvent[] = [];
  const adapters = new Map<string, Promise<ProviderAdapter>>();
  const env: ModelEnvironment = {
    adapter(model) {
      const name = model.provider.name;
      let a = adapters.get(name);
      if (!a) {
        const given = options.adapters?.[name];
        a = given
          ? Promise.resolve(given)
          : model.provider.profile.protocol === "anthropic"
            ? anthropicAdapter(model.provider, secrets)
            : model.provider.profile.protocol === "openai-chat"
              ? openAiChatAdapter(model.provider, secrets)
              : Promise.reject(new LlmError("configuration", `Provider ${name} is custom: pass its adapter in createLlm(config, { adapters: { "${name}": ... } })`, { provider: name }));
        // A failure to set up (a missing key, say) is not cached: the next call tries again.
        a.catch(() => adapters.delete(name));
        adapters.set(name, a);
      }
      return a;
    },
    validator: new OutputValidator(),
    ...(options.classification ? { scheme: options.classification } : {}),
    requireLabels: options.requireLabels === true,
    record(record) {
      usage.record(record);
      options.onCall?.(record);
    },
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
    repairAttempts: options.repairAttempts ?? 1
  };
  const managed = new Map<string, ManagedModel>();
  const raw = (id: string): ManagedModel => {
    let m = managed.get(id);
    if (!m) {
      const info = resolved.models.get(id);
      if (!info) {
        const why = resolved.diagnostics.find((d) => d.at.startsWith(`models/${id}`) && d.severity === "error");
        throw new LlmError("configuration", why ? `Model ${id} is misconfigured: ${why.message}` : `No model "${id}" is configured`, { model: id });
      }
      managed.set(id, (m = new ManagedModel(info, env)));
    }
    return m;
  };
  const allowedFor = (m: ResolvedModel, use: ModelUse) => {
    if (!m.uses.includes(use)) throw new LlmError("configuration", `Model ${m.id} is not configured for ${use} use`, { model: m.id });
  };

  const llm: Llm = {
    config: resolved,
    diagnostics: resolved.diagnostics,
    usage,
    fallbacks,
    models: () => [...resolved.models.values()],
    model(id, use, opts = {}) {
      const primary = raw(id);
      allowedFor(primary.info, use);
      if (opts.fallback === false || primary.info.fallbacks.length === 0) return primary;
      return withFallbacks(primary, primary.info.fallbacks.map(raw), use, env, fallbacks);
    },
    defaultModel(use) {
      const id = resolved.defaults[use];
      if (!id) throw new LlmError("configuration", `No default ${use} model is configured`);
      return llm.model(id, use);
    },
    select(req) {
      const considered: { id: string; rejected?: string }[] = [];
      const qualified: ResolvedModel[] = [];
      for (const m of resolved.models.values()) {
        const why = rejection(m, req, env);
        considered.push({ id: m.id, ...(why ? { rejected: why } : {}) });
        if (!why) qualified.push(m);
      }
      const price = (m: ResolvedModel) => m.pricing?.outputPerMillion ?? (m.provider.environment === "local" ? 0 : Number.POSITIVE_INFINITY);
      const prefer = req.prefer ?? "quality";
      qualified.sort(
        (a, b) =>
          (prefer === "cost" ? price(a) - price(b) : prefer === "containment" ? CONTAINMENT[a.provider.environment] - CONTAINMENT[b.provider.environment] : QUALITY[b.quality] - QUALITY[a.quality]) ||
          QUALITY[b.quality] - QUALITY[a.quality] ||
          CONTAINMENT[a.provider.environment] - CONTAINMENT[b.provider.environment] ||
          a.id.localeCompare(b.id)
      );
      const best = qualified[0];
      if (!best) throw new LlmError("unsupported-capability", `No configured model meets the requirements: ${considered.map((c) => `${c.id} (${c.rejected})`).join("; ") || "none is configured"}`);
      // A fallback must meet the same requirements: a selection made for zero retention is not answered by a model that retains.
      const primary = raw(best.id);
      const meeting = primary.info.fallbacks.filter((id) => {
        const m = resolved.models.get(id);
        return m !== undefined && rejection(m, req, env) === undefined;
      });
      return { model: meeting.length ? withFallbacks(primary, meeting.map(raw), req.use, env, fallbacks) : primary, considered };
    },
    async discover(name, opts = {}) {
      const provider = resolved.providers.get(name);
      if (!provider) throw new LlmError("configuration", `No provider "${name}" is configured`);
      const model = [...resolved.models.values()].find((m) => m.provider.name === name);
      const adapter = await env.adapter(model ?? ({ provider } as ResolvedModel));
      return adapter.listModels(opts.signal ?? new AbortController().signal);
    },
    async validate(opts = {}) {
      const out: ConfigDiagnostic[] = [];
      const names = opts.providers ?? [...resolved.providers.keys()];
      for (const name of names) {
        let listed: DiscoveredModel[];
        try {
          listed = await llm.discover(name, opts);
        } catch (err) {
          out.push({ code: "provider-unreachable", severity: "warning", at: `providers/${name}`, message: `${name} could not be asked what it serves: ${(err as Error).message}` });
          continue;
        }
        for (const m of resolved.models.values()) {
          if (m.provider.name !== name) continue;
          const found = listed.find((d) => d.id === m.model || d.id === `${m.model}:latest` || d.id.replace(/:latest$/, "") === m.model);
          if (!found) {
            out.push({ code: "model-not-served", severity: "error", at: `models/${m.id}/model`, message: `${name} does not list ${m.model}` });
            continue;
          }
          out.push(...contradictions(m, found));
        }
      }
      return out;
    }
  };
  return llm;
}

/** Why `m` does not meet `req`, or undefined. */
function rejection(m: ResolvedModel, req: ModelRequirements, env: ModelEnvironment): string | undefined {
  if (!m.uses.includes(req.use)) return `not configured for ${req.use} use`;
  for (const need of req.capabilities ?? []) {
    const missing = unmet(m.capabilities, need);
    if (missing) return `does not support ${missing}`;
  }
  if (req.minQuality && QUALITY[m.quality] < QUALITY[req.minQuality]) return `quality ${m.quality} is below ${req.minQuality}`;
  if (req.environments && !req.environments.includes(m.provider.environment)) return `runs ${m.provider.environment}`;
  if (req.retention && !req.retention.includes(m.retention.prompts)) return `retention is ${m.retention.prompts}`;
  if (req.maxOutputPricePerMillion !== undefined) {
    const price = m.pricing?.outputPerMillion ?? (m.provider.environment === "local" ? 0 : undefined);
    if (price === undefined) return "has no configured price";
    if (price > req.maxOutputPricePerMillion) return `costs ${price} per million output tokens`;
  }
  if (req.label && !decideRelease(env.scheme, m.audience, req.label, env.requireLabels).allow) return "may not receive this content";
  return undefined;
}

/** What the provider says that contradicts what the configuration declares. */
function contradictions(m: ResolvedModel, found: DiscoveredModel): ConfigDiagnostic[] {
  const out: ConfigDiagnostic[] = [];
  const c = found.capabilities ?? {};
  const at = `models/${m.id}/capabilities`;
  const say = (field: keyof ModelCapabilities, message: string) => out.push({ code: "capability-contradicted", severity: "error", at: `${at}/${field}`, message });
  if (c.tools === false && m.capabilities.tools) say("tools", `${m.id} declares tool calling; ${m.provider.name} says ${m.model} has none`);
  if (c.input && m.capabilities.input.includes("image") && !c.input.includes("image")) say("input", `${m.id} declares image input; ${m.provider.name} says ${m.model} takes none`);
  if (c.structuredOutput && m.capabilities.structuredOutput === "schema" && c.structuredOutput !== "schema") say("structuredOutput", `${m.id} declares schema-constrained output; ${m.provider.name} says ${m.model} offers ${c.structuredOutput}`);
  if (c.contextWindow !== undefined && m.capabilities.contextWindow !== undefined && m.capabilities.contextWindow > c.contextWindow) say("contextWindow", `${m.id} declares a ${m.capabilities.contextWindow}-token context; ${m.provider.name} says ${c.contextWindow}`);
  if (c.seed === false && m.capabilities.seed) say("seed", `${m.id} declares a seed; ${m.provider.name} says ${m.model} ignores one`);
  return out;
}

/**
 * `primary`, falling back in order to `candidates` when it is unavailable
 * (ADR-0075). Each fallback is admitted as if called directly: configured
 * for the use, able to do what is asked, and the content releasable to its
 * audience. A fallback less contained than the model before it (local to
 * hosted) is taken only when the primary's configuration says so and the
 * request is labeled, so a local failure never quietly sends unlabeled
 * content to a provider. Every fallback is recorded.
 */
function withFallbacks(primary: ManagedModel, candidates: readonly ManagedModel[], use: ModelUse, env: ModelEnvironment, log: FallbackEvent[]): LanguageModel {
  const admissible = (request: GenerateRequest, c: ManagedModel): string | undefined => {
    if (!c.info.uses.includes(use)) return `not configured for ${use} use`;
    const crosses = !withinBoundary(primary.info.provider.environment, c.info.provider.environment);
    if (crosses && !primary.info.crossBoundaryFallback) return `runs ${c.info.provider.environment}, outside ${primary.id}'s ${primary.info.provider.environment} boundary`;
    if (crosses && !request.label) return "the request is unlabeled, so it may not cross a boundary";
    const missing = requirementsOf(request)
      .map((n) => unmet(c.info.capabilities, n))
      .filter(Boolean);
    if (missing.length) return `does not support ${missing.join(", ")}`;
    if (!decideRelease(env.scheme, c.info.audience, request.label, env.requireLabels).allow) return "may not receive this content";
    if (request.releasedFor !== undefined && request.releasedFor !== c.info.audience.id) return `the content was read for audience ${request.releasedFor}`;
    return undefined;
  };
  const attempt = async <T>(request: GenerateRequest, call: (m: LanguageModel) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const [i, m] of [primary, ...candidates].entries()) {
      if (i > 0) {
        const why = admissible(request, m);
        if (why) {
          env.record({
            callId: crypto.randomUUID(),
            at: env.now().toISOString(),
            model: { id: m.id, provider: m.info.provider.name, providerModel: m.info.model },
            audience: m.info.audience.id,
            configDigest: m.info.configDigest,
            requestDigest: "",
            parameters: {},
            attempts: 0,
            latencyMs: 0,
            ...(request.purpose ? { purpose: request.purpose } : {}),
            fallbackFrom: { model: primary.id, code: (last as LlmError).code },
            error: { code: "fallback-refused", message: why }
          });
          continue;
        }
        log.push({ from: primary.id, to: m.id, code: (last as LlmError).code });
      }
      try {
        return await call(m);
      } catch (err) {
        if (!(err instanceof LlmError) || !FALLBACK_CODES.has(err.code)) throw err;
        last = err;
      }
    }
    throw last;
  };
  return {
    id: primary.id,
    info: primary.info,
    generate: (request: GenerateRequest, options?: CallOptions): Promise<GenerateResult> => attempt(request, (m) => m.generate(request, options)),
    // A stream goes to the primary only: what it has delivered cannot be taken back, so it does not move to another model.
    stream: (request: GenerateRequest, options?: CallOptions): ModelStream => primary.stream(request, options)
  };
}
