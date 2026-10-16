import type { ResolvedProvider } from "../config.js";
import { LlmError, codeForStatus, redactSecrets, retryAfterMs } from "../errors.js";
import type { Usage } from "../types.js";

/** Where credentials come from, read when a provider is first used: by default, the process environment. */
export type Secrets = (name: string) => string | undefined;
export const environmentSecrets: Secrets = (name) => process.env[name];

/** A provider SDK, imported only when a provider that needs it is used, so a deployment installs only what it configures. */
export async function loadSdk<T>(specifier: string, kind: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch {
    throw new LlmError("configuration", `A ${kind} provider needs the package ${specifier}: npm install ${specifier}`, { retryable: false });
  }
}

/** The provider's configured headers, credentials read from the environment. */
export function headersFor(provider: ResolvedProvider, secrets: Secrets): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [h, v] of Object.entries(provider.headers)) {
    const value = typeof v === "string" ? v : secrets(v.env);
    if (value === undefined) throw new LlmError("configuration", `Provider ${provider.name} needs ${typeof v === "string" ? h : v.env} set for header ${h}`, { provider: provider.name });
    out[h] = value;
  }
  return out;
}

/** The secret values a provider uses, so they can be redacted from anything an error carries. */
export function secretValues(provider: ResolvedProvider, secrets: Secrets): string[] {
  const values = [provider.apiKeyEnv ? secrets(provider.apiKeyEnv) : undefined, ...Object.values(provider.headers).map((v) => (typeof v === "string" ? undefined : secrets(v.env)))];
  return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Usage estimated from text, four characters a token, for a provider that reported none. */
export function estimateUsage(input: string, output: string): Usage {
  return { inputTokens: Math.ceil(input.length / 4), outputTokens: Math.ceil(output.length / 4), estimated: true };
}

/**
 * One of the vendor SDKs' errors (Anthropic's and OpenAI's share a shape:
 * `status`, `headers`, `error`, and named classes for aborts and
 * connection failures) as an `LlmError`. The message keeps the provider's
 * short reason, with anything that looks like a credential removed.
 */
export function normalizeSdkError(err: unknown, provider: ResolvedProvider, secrets: readonly string[]): LlmError {
  if (err instanceof LlmError) return err;
  const e = err as { name?: string; status?: number; headers?: { get(n: string): string | null }; message?: string; error?: unknown; constructor?: { name?: string } };
  const cls = e?.constructor?.name ?? e?.name ?? "";
  const base = { provider: provider.name };
  if (cls === "APIUserAbortError" || e?.name === "AbortError") return new LlmError("cancelled", `The call to ${provider.name} was cancelled`, base);
  if (cls === "APIConnectionTimeoutError") return new LlmError("timeout", `${provider.name} did not answer in time`, base);
  if (cls === "APIConnectionError") return new LlmError("unavailable", `${provider.name} could not be reached`, base);
  const detail = errorDetail(e?.error) ?? e?.message ?? String(err);
  const message = redactSecrets(detail, secrets).slice(0, 400);
  if (typeof e?.status === "number") {
    const type = typeof (e.error as { error?: { type?: unknown } } | undefined)?.error?.type === "string" ? String((e.error as { error: { type: string } }).error.type) : "";
    let code = codeForStatus(e.status, message);
    if (type === "overloaded_error") code = "overloaded";
    const wait = retryAfterMs(e.headers);
    return new LlmError(code, `${provider.name} answered ${e.status}: ${message}`, { ...base, status: e.status, ...(wait !== undefined ? { retryAfterMs: wait } : {}) });
  }
  return new LlmError("unavailable", `${provider.name} failed: ${message}`, base);
}

function errorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" ? body : undefined;
  const b = body as Record<string, unknown>;
  const inner = (b.error && typeof b.error === "object" ? b.error : b) as Record<string, unknown>;
  return typeof inner.message === "string" ? inner.message : undefined;
}
