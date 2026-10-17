import { describe, expect, it } from "vitest";
import { createLlm, type LlmConfig } from "@typesys/llm";
import { DEFAULT_CONFIG, SAMPLE_CONFIGS, SIMULATED_MODEL_ID, assess, describeModels, startSimulatedModel } from "../src/index.js";

describe("model configurations as the showcase shows them", () => {
  it("labels the stand-in and the loopback endpoint simulated, and every hosted provider real", () => {
    const env = { ANTHROPIC_API_KEY: "sk-secret-value" };
    const views = [DEFAULT_CONFIG, ...SAMPLE_CONFIGS].map((f) => describeModels(f, env));
    expect(views.map((v) => [v.file.split("/").pop(), v.simulated])).toEqual([
      ["typesys.llm.json", true],
      ["simulated.json", true],
      ["anthropic.json", false],
      ["openai.json", false],
      ["openrouter.json", false],
      ["ollama.json", false]
    ]);
    for (const v of views) expect(v.label.startsWith(v.simulated ? "SIMULATED" : "REAL"), v.file).toBe(true);
    const anthropic = views[2]!;
    expect(anthropic.providers[0]!.credential).toEqual({ env: "ANTHROPIC_API_KEY", set: true });
    // The variable's name, and whether it is set; never its value.
    expect(JSON.stringify(views)).not.toContain("sk-secret-value");
    expect(views[5]!.label).toContain("nothing leaves this machine");
  });
});

describe("the simulated model", () => {
  it("applies the stability rule, and says it is simulated", () => {
    expect(assess(JSON.stringify({ peakC: 8.6, minutesOut: 30, budgetMinutes: 120 }))).toMatchObject({ disposition: "release", confidence: "high" });
    expect(assess(JSON.stringify({ peakC: 11, minutesOut: 150, budgetMinutes: 120 })).disposition).toBe("quarantine");
    expect(assess(JSON.stringify({ peakC: -1.5, minutesOut: 20, budgetMinutes: 120 })).disposition).toBe("destroy");
    expect(assess("{}").confidence).toBe("low");
    expect(assess(JSON.stringify({ peakC: 5, minutesOut: 1, budgetMinutes: 9 })).rationale).toMatch(/\(simulated model\)$/);
  });

  it("answers through the real OpenAI-compatible provider path: discovery, then a structured completion", async () => {
    const model = await startSimulatedModel(0);
    try {
      const config: LlmConfig = {
        format: "typesys.llm/1",
        providers: { simulated: { kind: "openai-compatible", baseUrl: model.url, environment: "local" } },
        models: { stability: { provider: "simulated", model: SIMULATED_MODEL_ID, uses: ["runtime"], capabilities: { structuredOutput: "schema" } } }
      };
      const llm = createLlm(config);
      expect((await llm.discover("simulated")).map((m) => m.id)).toEqual([SIMULATED_MODEL_ID]);
      expect(await llm.validate({ providers: ["simulated"] })).toEqual([]);
      const res = await fetch(`${model.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: SIMULATED_MODEL_ID, messages: [{ role: "user", content: JSON.stringify({ peakC: 9.1, minutesOut: 140, budgetMinutes: 120 }) }] }) });
      expect(res.headers.get("x-typesys-simulated")).toBe("true");
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(JSON.parse(body.choices[0]!.message.content)).toMatchObject({ disposition: "quarantine", confidence: "medium" });
      expect(model.received).toHaveLength(1);
    } finally {
      await model.close();
    }
  });
});
