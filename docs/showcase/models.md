# Models in the showcase

Two different things use language models around TypeSystem, and the showcase keeps them apart.

**Claude Code is the developer.** It builds and changes applications at development time, through the `typesys` CLI and the MCP servers registered in [`.mcp.json`](../../.mcp.json). It is told only what its caller may see, and it holds no runtime credentials. Nothing in the running showcase calls it.

**A runtime model is part of an application.** Cold Chain Command's `assess` flow has an `ai` step that asks a configured model, through `@typesys/llm`, for a stability disposition of a temperature excursion. The runtime decides what that model's audience (`model:coldchain-enclave/stability`, cleared INTERNAL) may receive, so nothing classified above INTERNAL reaches it, and the checker refuses a flow in which a model's answer reaches an Action with side effects without a person approving it (`unreviewed-ai-output`). That is ADR-0074, ADR-0075 and ADR-0081; ADR-0078 is the development-time side, what a coding agent is given.

## What runs by default, and why it says so

No paid model is ever called by default, on any machine or in CI.

| Configuration | What answers | Label |
| --- | --- | --- |
| `examples/apps/cold-chain/typesys.llm.json` (the application's own default) | A deterministic stand-in inside the application's process (`kind: custom`) | **SIMULATED** |
| `examples/apps/cold-chain/llm/simulated.json` (what `npm run showcase` starts Cold Chain Command with) | The showcase's OpenAI-compatible endpoint on `127.0.0.1:4790`, through the real provider path: configuration, discovery, the OpenAI SDK over HTTP, structured output and release to the model's audience | **SIMULATED** |
| `llm/anthropic.json`, `llm/openai.json`, `llm/openrouter.json` | The hosted provider, with the key from the named environment variable | **REAL**, may bill |
| `llm/ollama.json` | A local Ollama server | **REAL**, nothing leaves the machine |

Both simulated paths apply the same fixed rule and end every rationale with "(simulated model)"; the loopback endpoint also sets the response header `x-typesys-simulated: true`. The guide's question 6 shows which configuration is active and how many requests the simulated endpoint has answered.

## Using a real provider

Pick a sample, put the model you want in its `model` field (the OpenAI, OpenRouter and Ollama samples say `REPLACE-WITH-…` on purpose, so nothing names a model that may not exist on your account), set the key, and check it before you start anything:

```bash
export ANTHROPIC_API_KEY=…
npm run showcase -- models examples/apps/cold-chain/llm/anthropic.json --discover
TYPESYS_LLM_CONFIG=examples/apps/cold-chain/llm/anthropic.json npm run showcase
```

`models` prints the providers, where each would send what it is given, whether the key variable is set (its name, never its value) and any configuration diagnostics. `--discover` asks each provider which models it serves (a listing request, which providers do not bill) and checks the configured model against the answer. A built Cold Chain Command reads `TYPESYS_LLM_CONFIG` too, without the showcase, so an operator can point it at another model without rebuilding it.

What changes with a real model: the disposition is the model's, not the rule's, and a hosted provider may bill for it. What does not change: the audience, the release decision, the review step and the audit, which are the runtime's and the same for every provider.

## Limits

The proxy in the environment this was built in blocks Ollama and Hugging Face downloads, so the real-provider paths were exercised against the simulated endpoint and by discovery against missing credentials, not against a live hosted model. Running one is a deliberate act with your own key.
