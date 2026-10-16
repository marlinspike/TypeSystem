import { canonical, type Audience } from "@typesys/core";
import { createHash } from "node:crypto";
import type { ModelCapabilities } from "./types.js";

export const LLM_CONFIG_FORMAT = "typesys.llm/1";

/** Where inference runs (ADR-0075): on this machine, on infrastructure the deployment controls, or at a provider. */
export type Environment = "local" | "private" | "hosted";
const CONTAINMENT: Readonly<Record<Environment, number>> = { local: 0, private: 1, hosted: 2 };
/** True when `to` is no less contained than `from`: local to local, local or private to private, anything to hosted is not. */
export const withinBoundary = (from: Environment, to: Environment): boolean => CONTAINMENT[to] <= CONTAINMENT[from];

/** Development-time intelligence (helping people build), or runtime intelligence (inside a governed application). Separate credentials and permissions. */
export type ModelUse = "development" | "runtime";

/** `custom`: an adapter the deployment supplies (`createLlm(config, { adapters })`) for a protocol TypeSystem does not speak. */
export type ProviderKind = "anthropic" | "openai" | "openrouter" | "ollama" | "lmstudio" | "vllm" | "openai-compatible" | "custom";
export const PROVIDER_KINDS: readonly ProviderKind[] = ["anthropic", "openai", "openrouter", "ollama", "lmstudio", "vllm", "openai-compatible", "custom"];

/** A header value, or the name of the environment variable that holds it: a secret never sits in configuration. */
export type HeaderValue = string | { readonly env: string };

export interface ProviderConfig {
  readonly kind: ProviderKind;
  /** The API's base URL; each kind has a default but `openai-compatible`. */
  readonly baseUrl?: string;
  /** The environment variable holding the API key. Never the key. */
  readonly apiKeyEnv?: string;
  /** Default from the kind and the base URL's host. `local` requires a loopback host. */
  readonly environment?: Environment;
  /** Extra headers (OpenRouter's `HTTP-Referer`, a gateway's tenant). Credentials only by `{ env }`. */
  readonly headers?: Readonly<Record<string, HeaderValue>>;
  readonly timeoutMs?: number;
  /** Attempts in all for a retryable failure. Default 3. */
  readonly maxAttempts?: number;
}

/** How long, and for what, a provider keeps what it is sent, as the operator has established it. Declared, audited and selectable, never assumed. */
export interface Retention {
  readonly prompts: "none" | "zero-data-retention" | "provider-default" | "unknown";
  readonly training: "no" | "yes" | "unknown";
}

export interface ModelConfig {
  /** A provider named in `providers`. */
  readonly provider: string;
  /** The provider's id for the model (`claude-opus-5-5`, `qwen2.5-coder:7b`). */
  readonly model: string;
  /** A version or digest to pin and record (`ollama show --modelfile`'s digest, a dated snapshot). */
  readonly version?: string;
  /** What this model is allowed to be used for. A model is used for nothing it does not list. */
  readonly uses: readonly ModelUse[];
  /**
   * Who receives what this model is sent (ADR-0067), as a principal the
   * deployment's policies grant roles and a clearance. Omitted, the model
   * is granted nothing. The id defaults to `model:<config id>`; the
   * provider, environment and retention are added to its attributes so a
   * policy can decide on them.
   */
  readonly audience?: { readonly id?: string; readonly roles?: readonly string[]; readonly attributes?: Readonly<Record<string, unknown>>; readonly clearance?: string };
  /** What the model can do, over its provider's defaults. */
  readonly capabilities?: Partial<ModelCapabilities>;
  /** A coarse rank for selection when several models qualify. Default `standard`. */
  readonly quality?: "basic" | "standard" | "advanced";
  /** Prices per million tokens, as the operator pays them; without them a call has no cost recorded. */
  readonly pricing?: { readonly inputPerMillion: number; readonly outputPerMillion: number; readonly cachedInputPerMillion?: number };
  readonly defaults?: { readonly temperature?: number; readonly maxOutputTokens?: number; readonly seed?: number };
  readonly retention?: Retention;
  /** Models to try, in order, when this one is unavailable. Each is decided on its own: its use, its capabilities, its release. */
  readonly fallbacks?: readonly string[];
  /**
   * Whether a fallback may be less contained than this model (local to
   * hosted, say). Off by default: a local model's failure never sends its
   * request somewhere else unless the operator wrote that it may, and even
   * then only to a model the content may be released to.
   */
  readonly crossBoundaryFallback?: boolean;
}

export interface LlmConfig {
  readonly format: typeof LLM_CONFIG_FORMAT;
  /** The operator's version of this configuration, recorded with every call. */
  readonly version?: string;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly models: Readonly<Record<string, ModelConfig>>;
  /** The model each use gets when a caller names none. */
  readonly defaults?: { readonly development?: string; readonly runtime?: string };
}

export interface ConfigDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  /** `providers/<name>/...` or `models/<id>/...`. */
  readonly at: string;
  readonly message: string;
  readonly hint?: string;
}

/** What each provider kind speaks and assumes until told otherwise. */
export interface ProviderProfile {
  readonly protocol: "anthropic" | "openai-chat" | "custom";
  readonly baseUrl?: string;
  readonly apiKey: "required" | "optional" | "none";
  readonly apiKeyEnv?: string;
  readonly hostedByDefault: boolean;
  readonly discovery: "anthropic" | "openai" | "openrouter" | "ollama";
  /** Chat-completions dialect: which parameter caps output, how structured output is asked for, whether usage is streamed. */
  readonly chat?: { readonly maxTokensParam: "max_tokens" | "max_completion_tokens"; readonly streamUsage: boolean; readonly requireParameters?: boolean };
  readonly capabilities: ModelCapabilities;
}

const TEXT_ONLY = ["text"] as const;
const TEXT_IMAGE = ["text", "image"] as const;

/**
 * The defaults are what the provider's protocol supports for the models
 * most deployments use; a model that differs says so in its own
 * `capabilities`, and `validateModels` compares both with discovery.
 */
export const PROFILES: Readonly<Record<ProviderKind, ProviderProfile>> = {
  anthropic: {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "required",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    hostedByDefault: true,
    discovery: "anthropic",
    // Current Claude models reject sampling parameters and have no seed.
    capabilities: { input: TEXT_IMAGE, tools: true, parallelToolCalls: true, streaming: true, structuredOutput: "schema", systemPrompt: true, temperature: false, seed: false }
  },
  openai: {
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "required",
    apiKeyEnv: "OPENAI_API_KEY",
    hostedByDefault: true,
    discovery: "openai",
    chat: { maxTokensParam: "max_completion_tokens", streamUsage: true },
    capabilities: { input: TEXT_IMAGE, tools: true, parallelToolCalls: true, streaming: true, structuredOutput: "schema", systemPrompt: true, temperature: true, seed: true }
  },
  openrouter: {
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "required",
    apiKeyEnv: "OPENROUTER_API_KEY",
    hostedByDefault: true,
    discovery: "openrouter",
    // OpenRouter routes one model to several upstream providers; requireParameters keeps it to the ones that honor what was asked.
    chat: { maxTokensParam: "max_tokens", streamUsage: true, requireParameters: true },
    capabilities: { input: TEXT_ONLY, tools: false, parallelToolCalls: false, streaming: true, structuredOutput: "none", systemPrompt: true, temperature: true, seed: false }
  },
  ollama: {
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "none",
    hostedByDefault: false,
    discovery: "ollama",
    chat: { maxTokensParam: "max_tokens", streamUsage: true },
    capabilities: { input: TEXT_ONLY, tools: false, parallelToolCalls: false, streaming: true, structuredOutput: "schema", systemPrompt: true, temperature: true, seed: true }
  },
  lmstudio: {
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "none",
    hostedByDefault: false,
    discovery: "openai",
    chat: { maxTokensParam: "max_tokens", streamUsage: true },
    capabilities: { input: TEXT_ONLY, tools: false, parallelToolCalls: false, streaming: true, structuredOutput: "schema", systemPrompt: true, temperature: true, seed: true }
  },
  vllm: {
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKey: "optional",
    hostedByDefault: false,
    discovery: "openai",
    chat: { maxTokensParam: "max_tokens", streamUsage: true },
    // Tool calling needs the server started with a tool parser; declare it per model when it is.
    capabilities: { input: TEXT_ONLY, tools: false, parallelToolCalls: false, streaming: true, structuredOutput: "schema", systemPrompt: true, temperature: true, seed: true }
  },
  "openai-compatible": {
    protocol: "openai-chat",
    apiKey: "optional",
    hostedByDefault: false,
    discovery: "openai",
    chat: { maxTokensParam: "max_tokens", streamUsage: false },
    // Compatible in protocol says nothing of behavior: assume nothing beyond text.
    capabilities: { input: TEXT_ONLY, tools: false, parallelToolCalls: false, streaming: true, structuredOutput: "none", systemPrompt: true, temperature: true, seed: false }
  },
  custom: {
    protocol: "custom",
    apiKey: "optional",
    hostedByDefault: false,
    discovery: "openai",
    capabilities: { input: TEXT_ONLY, tools: false, parallelToolCalls: false, streaming: true, structuredOutput: "none", systemPrompt: true, temperature: true, seed: false }
  }
};

/** A provider with every default applied. */
export interface ResolvedProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly profile: ProviderProfile;
  readonly baseUrl: string;
  readonly environment: Environment;
  readonly apiKeyEnv?: string;
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
}

/** A model with its provider, capabilities, audience and digest resolved. */
export interface ResolvedModel {
  readonly id: string;
  readonly provider: ResolvedProvider;
  readonly model: string;
  readonly version?: string;
  readonly uses: readonly ModelUse[];
  readonly audience: Audience;
  readonly capabilities: ModelCapabilities;
  readonly quality: "basic" | "standard" | "advanced";
  readonly pricing?: ModelConfig["pricing"];
  readonly defaults: NonNullable<ModelConfig["defaults"]>;
  readonly retention: Retention;
  readonly fallbacks: readonly string[];
  readonly crossBoundaryFallback: boolean;
  /** sha256 of the model's and its provider's configuration (no secrets are in it), recorded with every call. */
  readonly configDigest: string;
  readonly configVersion?: string;
}

export interface ResolvedConfig {
  readonly models: ReadonlyMap<string, ResolvedModel>;
  readonly providers: ReadonlyMap<string, ResolvedProvider>;
  readonly defaults: { readonly development?: string; readonly runtime?: string };
  readonly diagnostics: readonly ConfigDiagnostic[];
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie)$/i;

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Applies every default and checks everything that can be checked without
 * a network: names, references, credentials named by variable, environments
 * consistent with hosts, audiences consistent with what the configuration
 * says about the model. Errors leave the model or provider out.
 */
export function resolveConfig(config: LlmConfig, secret: (name: string) => string | undefined = (name) => process.env[name]): ResolvedConfig {
  const diagnostics: ConfigDiagnostic[] = [];
  const diag = (severity: ConfigDiagnostic["severity"], code: string, at: string, message: string, hint?: string) => diagnostics.push({ code, severity, at, message, ...(hint ? { hint } : {}) });
  if (config?.format !== LLM_CONFIG_FORMAT) diag("error", "invalid-config", "format", `format is not ${String(LLM_CONFIG_FORMAT)}`);

  const providers = new Map<string, ResolvedProvider>();
  for (const [name, p] of Object.entries(config?.providers ?? {})) {
    const at = `providers/${name}`;
    const before = diagnostics.length;
    if (!ID.test(name)) diag("error", "invalid-name", at, `provider name "${name}" is not lower case letters, digits, ".", "_" or "-"`);
    const profile = PROFILES[p?.kind];
    if (!profile) {
      diag("error", "unknown-provider-kind", `${at}/kind`, `"${String(p?.kind)}" is not a provider kind`, `one of ${PROVIDER_KINDS.join(", ")}`);
      continue;
    }
    const baseUrl = (p.baseUrl ?? profile.baseUrl ?? (p.kind === "custom" ? "custom:" : undefined))?.replace(/\/+$/, "");
    if (p.kind === "custom" && p.environment === undefined) diag("error", "missing-environment", `${at}/environment`, "a custom provider declares where it runs: local, private or hosted");
    if (p.kind === "custom") {
      // Its adapter is code the deployment supplies; nothing about a URL can be checked here.
    } else if (!baseUrl) diag("error", "missing-base-url", `${at}/baseUrl`, `a ${p.kind} provider needs baseUrl`);
    else if (!/^https?:\/\//.test(baseUrl)) diag("error", "invalid-base-url", `${at}/baseUrl`, `baseUrl must be an http or https URL`);
    else if (/^http:/.test(baseUrl) && !isLoopback(baseUrl) && (p.environment ?? (profile.hostedByDefault ? "hosted" : "private")) === "hosted")
      diag("error", "insecure-base-url", `${at}/baseUrl`, "a hosted provider is reached over https", "use https, or declare the environment private if it is on your own network");
    const environment: Environment = p.environment ?? (profile.hostedByDefault ? "hosted" : baseUrl && isLoopback(baseUrl) ? "local" : "private");
    if (environment === "local" && baseUrl && p.kind !== "custom" && !isLoopback(baseUrl))
      diag("error", "environment-mismatch", `${at}/environment`, `environment "local" names a provider on this machine, and ${new URL(baseUrl).hostname} is not`, 'declare "private" for a server on your own network');
    if (profile.hostedByDefault && environment !== "hosted")
      diag("error", "environment-mismatch", `${at}/environment`, `${p.kind} runs at the provider: its environment is hosted`);
    if (p.apiKeyEnv !== undefined && !ENV.test(p.apiKeyEnv)) diag("error", "invalid-credential-reference", `${at}/apiKeyEnv`, "apiKeyEnv names an environment variable, never holds a key", 'e.g. "ANTHROPIC_API_KEY"');
    const apiKeyEnv = p.apiKeyEnv ?? profile.apiKeyEnv;
    if (profile.apiKey === "required" && apiKeyEnv && !secret(apiKeyEnv)) diag("warning", "missing-credential", `${at}/apiKeyEnv`, `${apiKeyEnv} is not set; calls to ${name} will fail`);
    for (const [h, v] of Object.entries(p.headers ?? {})) {
      if (typeof v === "string" && CREDENTIAL_HEADER.test(h)) diag("error", "credential-in-config", `${at}/headers/${h}`, `header ${h} carries a credential; give it as { "env": "<VARIABLE>" }`);
      if (typeof v === "object" && !ENV.test(v?.env ?? "")) diag("error", "invalid-credential-reference", `${at}/headers/${h}`, "a header from the environment names its variable");
    }
    if (p.timeoutMs !== undefined && !(Number.isSafeInteger(p.timeoutMs) && p.timeoutMs > 0)) diag("error", "invalid-timeout", `${at}/timeoutMs`, "timeoutMs is a positive whole number");
    if (p.maxAttempts !== undefined && !(Number.isSafeInteger(p.maxAttempts) && p.maxAttempts >= 1 && p.maxAttempts <= 10)) diag("error", "invalid-attempts", `${at}/maxAttempts`, "maxAttempts is a whole number from 1 to 10");
    if (diagnostics.slice(before).some((d) => d.severity === "error") || !baseUrl) continue;
    providers.set(name, {
      name,
      kind: p.kind,
      profile,
      baseUrl,
      environment,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      headers: p.headers ?? {},
      timeoutMs: p.timeoutMs ?? 120_000,
      maxAttempts: p.maxAttempts ?? 3
    });
  }

  const models = new Map<string, ResolvedModel>();
  const declared = config?.models ?? {};
  for (const [id, m] of Object.entries(declared)) {
    const at = `models/${id}`;
    const before = diagnostics.length;
    if (!ID.test(id)) diag("error", "invalid-name", at, `model id "${id}" is not lower case letters, digits, ".", "_" or "-"`);
    const provider = providers.get(m?.provider);
    if (!provider) diag("error", "unknown-provider", `${at}/provider`, `"${String(m?.provider)}" is not a configured provider (or its configuration has errors)`);
    if (typeof m?.model !== "string" || m.model === "") diag("error", "missing-model", `${at}/model`, "model names the provider's model id");
    const uses = Array.isArray(m?.uses) ? m.uses : [];
    if (uses.length === 0 || uses.some((u) => u !== "development" && u !== "runtime")) diag("error", "invalid-uses", `${at}/uses`, 'uses lists "development", "runtime", or both');
    for (const f of m?.fallbacks ?? []) {
      if (f === id) diag("error", "invalid-fallback", `${at}/fallbacks`, "a model is not its own fallback");
      else if (!Object.hasOwn(declared, f)) diag("error", "unknown-fallback", `${at}/fallbacks`, `fallback "${f}" is not a configured model`);
    }
    if (m?.pricing && !(m.pricing.inputPerMillion >= 0 && m.pricing.outputPerMillion >= 0)) diag("error", "invalid-pricing", `${at}/pricing`, "prices are numbers of currency units per million tokens, zero or more");
    if (diagnostics.slice(before).some((d) => d.severity === "error") || !provider) continue;

    const retention: Retention = m.retention ?? { prompts: provider.environment === "hosted" ? "unknown" : "none", training: provider.environment === "hosted" ? "unknown" : "no" };
    const derived: Record<string, unknown> = { provider: provider.kind, environment: provider.environment, providerModel: m.model, retention: retention.prompts, training: retention.training };
    const declaredAttrs = m.audience?.attributes ?? {};
    for (const [k, v] of Object.entries(derived)) {
      if (Object.hasOwn(declaredAttrs, k) && canonical(declaredAttrs[k]) !== canonical(v))
        diag("error", "audience-mismatch", `${at}/audience/attributes/${k}`, `the audience says ${k} is ${JSON.stringify(declaredAttrs[k])}, and the configuration says ${JSON.stringify(v)}`, "a policy decides on what the configuration says the model is; remove the attribute or correct it");
    }
    if (diagnostics.slice(before).some((d) => d.severity === "error")) continue;
    const audience: Audience = {
      id: m.audience?.id ?? `model:${id}`,
      kind: "model",
      roles: [...(m.audience?.roles ?? [])],
      attributes: { ...declaredAttrs, ...derived },
      ...(m.audience?.clearance !== undefined ? { clearance: m.audience.clearance } : {})
    };
    if (!m.audience) diag("warning", "no-audience", `${at}/audience`, `${id} has no audience: it is granted nothing, so it receives only what a policy grants everyone`);
    const capabilities: ModelCapabilities = { ...provider.profile.capabilities, ...(m.capabilities ?? {}) };
    const digestOf = { provider: { kind: provider.kind, baseUrl: provider.baseUrl, environment: provider.environment }, model: { ...m, audience }, version: config.version };
    models.set(id, {
      id,
      provider,
      model: m.model,
      ...(m.version ? { version: m.version } : {}),
      uses,
      audience,
      capabilities,
      quality: m.quality ?? "standard",
      ...(m.pricing ? { pricing: m.pricing } : {}),
      defaults: m.defaults ?? {},
      retention,
      fallbacks: m.fallbacks ?? [],
      crossBoundaryFallback: m.crossBoundaryFallback === true,
      configDigest: createHash("sha256").update(canonical(digestOf)).digest("hex"),
      ...(config.version ? { configVersion: config.version } : {})
    });
  }
  for (const use of ["development", "runtime"] as const) {
    const d = config?.defaults?.[use];
    if (d === undefined) continue;
    const m = models.get(d);
    if (!m) diag("error", "unknown-default", `defaults/${use}`, `default ${use} model "${d}" is not a configured model (or its configuration has errors)`);
    else if (!m.uses.includes(use)) diag("error", "default-not-allowed", `defaults/${use}`, `"${d}" is not configured for ${use} use`, `add "${use}" to its uses`);
  }
  return { models, providers, defaults: config?.defaults ?? {}, diagnostics };
}
