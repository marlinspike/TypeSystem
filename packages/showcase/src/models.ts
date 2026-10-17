import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createLlm, resolveConfig, type LlmConfig } from "@typesys/llm";
import { SIMULATED_LLM } from "./catalog.js";
import { ROOT } from "./stack.js";

/** The configuration Cold Chain Command runs with when nothing else is named: an in-process stand-in. */
export const DEFAULT_CONFIG = "examples/apps/cold-chain/typesys.llm.json";
/** The provider configurations the repository carries for the same model role. */
export const SAMPLE_CONFIGS = ["simulated", "anthropic", "openai", "openrouter", "ollama"].map((n) => `examples/apps/cold-chain/llm/${n}.json`);

export interface ModelsView {
  readonly file: string;
  readonly simulated: boolean;
  /** Why it is, or is not, simulated, in a sentence. */
  readonly label: string;
  readonly providers: readonly { readonly name: string; readonly kind: string; readonly baseUrl?: string; readonly environment: string; readonly credential?: { readonly env: string; readonly set: boolean } }[];
  readonly models: readonly { readonly id: string; readonly provider: string; readonly model: string; readonly uses: readonly string[]; readonly audience?: string }[];
  readonly diagnostics: readonly string[];
}

/**
 * A model configuration as an operator reads it: providers, models, where
 * each would send what it is given, and whether its credential is set (the
 * variable's name, never its value). `simulated` when nothing in it reaches a
 * real model: the in-process stand-in, or the showcase's loopback one.
 */
export function describeModels(file: string, env: NodeJS.ProcessEnv = process.env): ModelsView {
  const abs = path.resolve(ROOT, file);
  if (!existsSync(abs)) throw new Error(`${file} does not exist`);
  const config = JSON.parse(readFileSync(abs, "utf8")) as LlmConfig;
  const resolved = resolveConfig(config, (name) => env[name]);
  const simulatedUrl = `http://127.0.0.1:${SIMULATED_LLM.port}/v1`;
  const providers = [...resolved.providers.values()].map((p) => {
    const credential = p.apiKeyEnv ? { env: p.apiKeyEnv, set: Boolean(env[p.apiKeyEnv]) } : undefined;
    return { name: p.name, kind: p.kind, ...(p.kind === "custom" ? {} : { baseUrl: p.baseUrl }), environment: p.environment, ...(credential ? { credential } : {}) };
  });
  const standIn = providers.filter((p) => p.kind === "custom" || p.baseUrl === simulatedUrl);
  const simulated = providers.length > 0 && standIn.length === providers.length;
  return {
    file,
    simulated,
    label: simulated
      ? providers.some((p) => p.kind === "custom")
        ? "SIMULATED: a deterministic stand-in in the application's process answers; no model is called."
        : "SIMULATED: the showcase's deterministic OpenAI-compatible endpoint on loopback answers, through the real provider path; no model is called."
      : `REAL: calls go to ${providers.map((p) => `${p.name} (${p.kind}, ${p.environment})`).join(", ")}${providers.some((p) => p.environment === "hosted") ? "; a hosted provider may bill for usage" : "; nothing leaves this machine"}.`,
    providers,
    models: [...resolved.models.values()].map((m) => ({ id: m.id, provider: m.provider.name, model: m.model, uses: [...m.uses], ...(m.audience ? { audience: m.audience.id } : {}) })),
    diagnostics: resolved.diagnostics.map((d) => `${d.severity} ${d.code} at ${d.at}: ${d.message}`)
  };
}

/** What each provider says it serves (one listing request each, which providers do not bill), and each configured model checked against it. */
export async function discoverModels(file: string): Promise<readonly string[]> {
  const config = JSON.parse(readFileSync(path.resolve(ROOT, file), "utf8")) as LlmConfig;
  const llm = createLlm(config);
  const out: string[] = [];
  for (const name of Object.keys(config.providers)) {
    if (config.providers[name]!.kind === "custom") {
      out.push(`${name}: custom, answered in process; nothing to discover`);
      continue;
    }
    try {
      const listed = await llm.discover(name);
      out.push(`${name}: serves ${listed.length} model${listed.length === 1 ? "" : "s"}${listed.length ? `: ${listed.slice(0, 12).map((m) => m.id).join(", ")}${listed.length > 12 ? ", …" : ""}` : ""}`);
    } catch (err) {
      out.push(`${name}: could not be asked: ${(err as Error).message}`);
    }
  }
  for (const d of await llm.validate({ providers: Object.keys(config.providers).filter((n) => config.providers[n]!.kind !== "custom") })) out.push(`${d.severity} ${d.code} at ${d.at}: ${d.message}`);
  return out;
}

/** The text `showcase models` prints. */
export function renderModels(v: ModelsView): string[] {
  return [
    `${v.file}`,
    `  ${v.label}`,
    ...v.providers.map((p) => `  provider ${p.name}: ${p.kind}${p.baseUrl ? ` at ${p.baseUrl}` : ""}, ${p.environment}${p.credential ? `, key in ${p.credential.env} (${p.credential.set ? "set" : "not set"})` : ""}`),
    ...v.models.map((m) => `  model ${m.id}: ${m.provider}/${m.model}, for ${m.uses.join(" and ")}${m.audience ? `, audience ${m.audience}` : ""}`),
    ...v.diagnostics.map((d) => `  ${d}`)
  ];
}
