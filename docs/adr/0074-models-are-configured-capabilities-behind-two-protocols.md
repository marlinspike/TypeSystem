# 0074. Models Are Configured Capabilities Behind Two Protocols

## Status

Accepted (2026-10-16). Implemented in `packages/llm/` (`@typesys/llm`),
proven by `packages/llm/test/providers.test.ts` and
`packages/llm/test/routing.test.ts`, which run the official vendor SDKs
against a provider on loopback that speaks their wire formats.

## Context

TypeSystem has had a model seam since ADR-0057 (`AiModel` in
`@typesys/workflow`) and a model principal since ADR-0067 (`Audience`),
but nothing that calls a model. Every use so far was a scripted stand-in.
The next capabilities (semantic onboarding, natural-language engineering,
AI steps in production workflows) need real models, and the people who run
TypeSystem need a choice of where those models run: Anthropic and OpenAI
directly, OpenRouter, and models on their own hardware through Ollama,
LM Studio, vLLM or any server that speaks the OpenAI Chat Completions
protocol.

Three ways to build this were considered:

- **A general multi-provider framework** (the Vercel AI SDK, LangChain.js,
  LiteLLM behind a proxy). Each brings its own model of messages, tools,
  structured output and retries. TypeSystem would then govern a second
  abstraction it does not own, and every release decision would depend on
  how that framework maps requests to providers, which changes with its
  versions. The proxy option adds a service to operate, a second place
  credentials live, and a hop that can log content.
- **Raw HTTP per provider.** Full control, but re-implements streaming
  parsers, error classes and retry hints the vendors already maintain.
- **The vendors' own SDKs under a thin layer TypeSystem owns.** The
  official `@anthropic-ai/sdk` and `openai` packages handle the wire
  protocol; TypeSystem owns capabilities, configuration, release,
  validation, retries, accounting and tracing.

## Decision

**Capabilities, not providers, are the abstraction.** A configured model
declares what it can do (`ModelCapabilities`: input kinds, tools, parallel
tool calls, streaming, structured output as `schema`, `json` or `none`,
system prompts, temperature, seed, context window, output limit). A
request states what it needs; a model that cannot meet it is refused with
`unsupported-capability` before anything is sent, never silently degraded.
Multimodal input is declared (`image`, `document`) but no part of
TypeSystem sends it yet.

**Two protocols.** Anthropic Messages, spoken natively (structured output
through `output_config.format`, thinking blocks returned and echoed back
opaquely), and OpenAI Chat Completions, spoken to OpenAI, OpenRouter,
Ollama, LM Studio, vLLM and `custom` servers. Differences between
Chat Completions servers are a per-kind profile (`PROFILES` in
`config.ts`: which token-limit parameter, whether stream usage is
requested, OpenRouter's `provider.require_parameters` so a route that
cannot honor a schema is not taken). Discovery uses each server's own
listing (`/models`, OpenRouter's `supported_parameters`, Ollama's
`/api/tags` and `/api/show`).

**The SDKs are optional peers, pinned, loaded on first use.** Their own
retries are off; TypeSystem retries `rate-limited`, `overloaded`,
`unavailable` and `timeout` with jittered exponential backoff that honors
`retry-after`, and a stream only before its first delivered event.
Every failure is one `LlmError` with a closed set of codes.

**Structured output is validated independently.** Whatever the provider
claims, the answer is parsed and validated against the request's JSON
Schema 2020-12 with Ajv; one repair round is allowed, then
`invalid-output`. A model with `structuredOutput: "json"` is instructed
and validated; one with `"none"` is refused for schema requests.

**Configuration is a versioned, digested document** (`typesys.llm/1`).
Credentials are named by environment variable and never stored;
`resolveConfig` reports a credential in the file, a non-loopback URL
declared `local`, plain HTTP to a non-loopback host, a hosted kind not
declared `hosted`, a model audience whose derived attributes disagree with
its provider, unknown fallbacks and defaults outside declared
capabilities. The configuration digest and the request digest are on
every call record, so a call can be tied to the exact configuration that
made it.

**Every call is a record, and records carry no content.** `CallRecord`
holds the model and provider, the audience, digests, parameters,
attempts, finish reason, usage (marked `estimated` where the provider
reported none), cost from configured prices, latency and time to first
token. Spans follow the OpenTelemetry GenAI conventions without prompt
or completion text. Secrets are redacted from every error message.

**Development-time and runtime models are separate.** A model is
configured for `development` (onboarding, engineering) or `runtime`
(workflow AI steps) uses, and asking for a use it is not configured for
is refused. Runtime never needs a model: every package keeps working with
none configured.

## Consequences

- Adding a provider that speaks Chat Completions is configuration, not
  code. A provider with its own protocol needs an adapter
  (`ProviderAdapter`: `generate`, `stream`, `listModels`).
- TypeSystem tracks two SDKs' releases. They are optional peers, so an
  installation that uses only local models needs only `openai`, which
  speaks Chat Completions to them.
- No test in CI calls a paid API. Real-provider tests
  (`packages/llm/test/live.test.ts`) run only when
  `TYPESYS_LLM_LIVE_CONFIG` names a configuration file.
- Cost is computed from configured prices, never fetched, so it is only
  as current as the configuration.
