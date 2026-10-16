/**
 * Every way a model call can fail, the same for every provider (ADR-0074).
 * `retryable` says whether the same request may succeed if sent again; the
 * caller never parses a provider's message to decide.
 */
export type LlmErrorCode =
  /** The model does not declare what the request needs. Nothing was sent. */
  | "unsupported-capability"
  /** The configuration is wrong: an unknown model, a missing credential, a provider kind that does not exist. Nothing was sent. */
  | "configuration"
  /** The content may not go to this model (ADR-0075). Nothing was sent. */
  | "release-refused"
  | "invalid-request"
  | "authentication"
  | "permission"
  | "not-found"
  | "context-length"
  | "rate-limited"
  | "overloaded"
  | "unavailable"
  | "timeout"
  | "cancelled"
  /** The model declined to answer. */
  | "refused"
  /** The provider answered something that is not a well-formed answer (bad JSON, a stream that ended early). */
  | "malformed-response"
  /** The answer is well formed but does not satisfy the requested schema, after any repair attempts. */
  | "invalid-output";

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set(["rate-limited", "overloaded", "unavailable", "timeout", "malformed-response"]);

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  /** The configured model id, when one was involved. */
  readonly model?: string;
  readonly provider?: string;
  readonly status?: number;
  /** How long the provider asked to wait, from `retry-after`. */
  readonly retryAfterMs?: number;
  /** For `invalid-output`: what was wrong with the answer, from the validator. Never the answer itself. */
  readonly problems?: readonly string[];

  constructor(
    code: LlmErrorCode,
    message: string,
    extra: { model?: string; provider?: string; status?: number; retryAfterMs?: number; problems?: readonly string[]; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = "LlmError";
    this.code = code;
    this.retryable = extra.retryable ?? RETRYABLE.has(code);
    if (extra.model !== undefined) this.model = extra.model;
    if (extra.provider !== undefined) this.provider = extra.provider;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra.problems !== undefined) this.problems = extra.problems;
  }
}

/** The code an HTTP status means, before a provider's own error type refines it. */
export function codeForStatus(status: number | undefined, message = ""): LlmErrorCode {
  if (status === undefined) return "unavailable";
  if (status === 400 || status === 422) return /context|too long|maximum.*tokens|prompt is too long/i.test(message) ? "context-length" : "invalid-request";
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 408) return "timeout";
  if (status === 413) return "context-length";
  if (status === 429) return "rate-limited";
  if (status === 529) return "overloaded";
  if (status >= 500) return "unavailable";
  return "invalid-request";
}

/** `retry-after` in milliseconds: seconds, an HTTP date, or `retry-after-ms`. */
export function retryAfterMs(headers: { get(name: string): string | null } | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.ceil(Number(ms));
  const value = headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Removes anything that looks like a credential from text that may reach a
 * log, a trace or an error message: the configured secrets themselves, and
 * the shapes provider keys and bearer tokens take.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted]");
  return out
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|x-api-key|authorization)["'\s:=]+)[^\s"',}]{8,}/gi, "$1[redacted]");
}
