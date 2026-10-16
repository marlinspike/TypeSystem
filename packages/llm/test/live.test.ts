import { describe, it, expect } from "vitest";
import type { JsonSchema2020 } from "@typesys/core";
import { createLlm, loadLlmConfig } from "../src/index.js";

/**
 * Against real providers, opt-in (ADR-0074): runs only when
 * `TYPESYS_LLM_LIVE_CONFIG` names a model configuration, so CI never calls
 * a provider and never spends money. Point it at a local server (Ollama,
 * LM Studio, vLLM) to run it for free; a hosted model costs a few cents.
 * `TYPESYS_LLM_LIVE_MODEL` picks the model, else the first configured.
 */
const path = process.env.TYPESYS_LLM_LIVE_CONFIG;

describe.skipIf(!path)("live provider (opt-in)", () => {
  const setup = async () => {
    const config = (await loadLlmConfig(path))!;
    const llm = createLlm(config);
    const id = process.env.TYPESYS_LLM_LIVE_MODEL ?? llm.models()[0]!.id;
    const info = llm.models().find((m) => m.id === id)!;
    return { llm, model: llm.model(id, info.uses[0]!), info };
  };

  it("the configuration validates against what the providers list", async () => {
    const { llm } = await setup();
    const problems = (await llm.validate()).filter((d) => d.severity === "error");
    expect(problems).toEqual([]);
  });

  it("answers text, and the call is recorded with usage and latency", async () => {
    const { llm, model } = await setup();
    const r = await model.generate({ messages: [{ role: "user", content: "Reply with the single word: ready" }], maxOutputTokens: 64 });
    expect(r.text.toLowerCase()).toContain("ready");
    expect(r.record.latencyMs).toBeGreaterThan(0);
    expect(llm.usage.totals().calls).toBeGreaterThan(0);
  }, 120_000);

  it("answers an object that validates against a JSON Schema", async () => {
    const { model, info } = await setup();
    if (info.capabilities.structuredOutput === "none") return;
    const schema = { type: "object", properties: { tail: { type: "string" }, urgent: { type: "boolean" } }, required: ["tail", "urgent"], additionalProperties: false } satisfies JsonSchema2020;
    const r = await model.generate({ messages: [{ role: "user", content: "Aircraft AF86-0147 has an avionics fault that grounds it. Give its tail number and whether it is urgent." }], output: { schema, name: "triage" }, maxOutputTokens: 256 });
    expect(r.object).toMatchObject({ tail: "AF86-0147", urgent: true });
  }, 120_000);

  it("streams", async () => {
    const { model, info } = await setup();
    if (!info.capabilities.streaming) return;
    let text = "";
    for await (const e of model.stream({ messages: [{ role: "user", content: "Count from one to five in words." }], maxOutputTokens: 64 })) if (e.type === "text") text += e.text;
    expect(text.toLowerCase()).toContain("three");
  }, 120_000);
});
