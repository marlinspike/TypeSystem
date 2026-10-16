import { describe, expect, it } from "vitest";
import { DEMO_LINEAR_CLASSIFICATION, withAudience } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { createLlm, governedReadTools, LlmError, resolveConfig, runTools, scriptedAdapter, type CallRecord, type LlmConfig, type ScriptedAnswer } from "../src/index.js";

/**
 * Selection, fallback and release (ADR-0075): which model a request may go
 * to is decided before it is sent, for each model on its own, and a local
 * model's failure never quietly sends content somewhere less contained.
 */
const down: ScriptedAnswer = { error: new LlmError("unavailable", "down") };

function fleet(overrides: { primary?: Record<string, unknown> } = {}, answers: Record<string, ScriptedAnswer[]> = {}) {
  const config = {
    format: "typesys.llm/1",
    providers: {
      laptop: { kind: "custom", environment: "local" },
      gpu: { kind: "custom", environment: "private" },
      cloud: { kind: "custom", environment: "hosted" }
    },
    models: {
      small: { provider: "laptop", model: "small", uses: ["development", "runtime"], quality: "basic", audience: { clearance: "SECRET" }, fallbacks: ["other-local", "enclave", "frontier"], ...overrides.primary },
      "other-local": { provider: "laptop", model: "other", uses: ["development"], quality: "basic", audience: { clearance: "SECRET" } },
      enclave: { provider: "gpu", model: "enclave", uses: ["development", "runtime"], quality: "standard", audience: { clearance: "CUI" }, capabilities: { tools: true } },
      frontier: { provider: "cloud", model: "frontier", uses: ["development"], quality: "advanced", audience: { clearance: "UNCLASSIFIED" }, pricing: { inputPerMillion: 4, outputPerMillion: 20 }, capabilities: { tools: true, structuredOutput: "schema" } }
    },
    defaults: { development: "small" }
  } as unknown as LlmConfig;
  const records: CallRecord[] = [];
  const adapter = (name: string) => scriptedAdapter(answers[name] ?? ["ok"]);
  const adapters = { laptop: adapter("laptop"), gpu: adapter("gpu"), cloud: adapter("cloud") };
  const llm = createLlm(config, { classification: DEMO_LINEAR_CLASSIFICATION, adapters, onCall: (r) => records.push(r) });
  return { llm, records, adapters };
}

describe("configuration says what each model is, and a policy can decide on it", () => {
  it("an audience carries the provider, environment and retention the configuration states; a contradicting attribute is an error", () => {
    const { llm } = fleet();
    expect(llm.models().find((m) => m.id === "frontier")!.audience).toEqual({
      id: "model:frontier",
      kind: "model",
      roles: [],
      attributes: { provider: "custom", environment: "hosted", providerModel: "frontier", retention: "unknown", training: "unknown" },
      clearance: "UNCLASSIFIED"
    });
    const bad = resolveConfig({ format: "typesys.llm/1", providers: { o: { kind: "ollama" } }, models: { m: { provider: "o", model: "x", uses: ["runtime"], audience: { attributes: { environment: "enclave" } } } } });
    expect(bad.diagnostics).toContainEqual(expect.objectContaining({ code: "audience-mismatch", at: "models/m/audience/attributes/environment" }));
    expect(bad.models.has("m")).toBe(false);
  });

  it("local means this machine; a credential is never written in configuration; an http hosted endpoint is refused", () => {
    const r = resolveConfig({
      format: "typesys.llm/1",
      providers: {
        remote: { kind: "ollama", baseUrl: "http://gpu-box.internal:11434/v1", environment: "local" },
        leaky: { kind: "openai-compatible", baseUrl: "https://gw.example/v1", environment: "hosted", headers: { Authorization: "Bearer abc" } },
        plain: { kind: "openai-compatible", baseUrl: "http://gw.example/v1", environment: "hosted" },
        inferred: { kind: "vllm", baseUrl: "http://10.0.0.5:8000/v1" }
      },
      models: {}
    });
    expect(r.diagnostics.map((d) => `${d.at} ${d.code}`)).toEqual(["providers/remote/environment environment-mismatch", "providers/leaky/headers/Authorization credential-in-config", "providers/plain/baseUrl insecure-base-url"]);
    expect(r.providers.get("inferred")!.environment).toBe("private");
  });
});

describe("selection", () => {
  it("picks the best qualifying model and says why each other was rejected", () => {
    const { llm } = fleet();
    const s = llm.select({ use: "development", capabilities: [{ capability: "tools" }] });
    expect(s.model.id).toBe("frontier");
    expect(s.considered).toContainEqual({ id: "small", rejected: "does not support tools" });
  });

  it("an environment constraint, a price ceiling or a label narrows it; containment preference puts the most contained first", () => {
    const { llm } = fleet();
    expect(llm.select({ use: "development", environments: ["local", "private"], minQuality: "standard" }).model.id).toBe("enclave");
    const cheap = llm.select({ use: "development", maxOutputPricePerMillion: 10 });
    expect(["small", "other-local"]).toContain(cheap.model.id);
    expect(cheap.considered).toContainEqual({ id: "frontier", rejected: "costs 20 per million output tokens" });
    expect(cheap.considered).toContainEqual({ id: "enclave", rejected: "has no configured price" });
    expect(llm.select({ use: "development", label: { markings: ["CUI"] } }).considered.find((c) => c.id === "frontier")!.rejected).toBe("may not receive this content");
    expect(llm.select({ use: "development", prefer: "containment" }).model.id).toBe("other-local");
    expect(() => llm.select({ use: "runtime", label: { markings: ["SECRET"] }, capabilities: [{ capability: "tools" }] })).toThrow(/No configured model meets the requirements/);
  });
});

describe("release: content goes only to a model its label may be released to", () => {
  it("SECRET content is refused for a CUI model before anything is sent; the refusal's reason is recorded, not returned", async () => {
    const { llm, records, adapters } = fleet();
    const err = (await llm.model("enclave", "development").generate({ messages: [{ role: "user", content: "x" }], label: { markings: ["SECRET"] } }).catch((e: unknown) => e)) as LlmError;
    expect(err).toMatchObject({ code: "release-refused", message: "The request may not be sent to model enclave" });
    expect(adapters.gpu.requests).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({ attempts: 0, error: { code: "release-refused" } });
    expect(records.at(-1)!.error!.message).toMatch(/not releasable to model:enclave/);
  });

  it("marked content with no classification scheme is refused; a deployment can require every request to be labeled", async () => {
    const config = { format: "typesys.llm/1", providers: { l: { kind: "custom", environment: "local" } }, models: { m: { provider: "l", model: "m", uses: ["runtime"] } } } as LlmConfig;
    const bare = createLlm(config, { adapters: { l: scriptedAdapter(["ok"]) } });
    await expect(bare.model("m", "runtime").generate({ messages: [{ role: "user", content: "x" }], label: { markings: ["CUI"] } })).rejects.toMatchObject({ code: "release-refused" });
    const strict = createLlm(config, { adapters: { l: scriptedAdapter(["ok"]) }, requireLabels: true });
    await expect(strict.model("m", "runtime").generate({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "release-refused" });
    expect((await strict.model("m", "runtime").generate({ messages: [{ role: "user", content: "x" }], label: { markings: [] } })).text).toBe("ok");
  });
});

describe("fallback (ADR-0075)", () => {
  it("an unavailable local model falls back to another local model", async () => {
    const { llm, adapters } = fleet({}, { laptop: [down, down, down, "from other-local"] });
    const r = await llm.model("small", "development").generate({ messages: [{ role: "user", content: "x" }] }, { maxAttempts: 3 });
    expect(r.text).toBe("from other-local");
    expect(r.record.model.id).toBe("other-local");
    expect(llm.fallbacks).toEqual([{ from: "small", to: "other-local", code: "unavailable" }]);
    expect(adapters.gpu.requests).toHaveLength(0);
  });

  it("never crosses out of the local boundary unless the configuration allows it: the primary's failure is what the caller sees", async () => {
    const { llm, adapters, records } = fleet({ primary: { fallbacks: ["enclave", "frontier"] } }, { laptop: [down] });
    await expect(llm.model("small", "development").generate({ messages: [{ role: "user", content: "x" }], label: { markings: [] } }, { maxAttempts: 1 })).rejects.toMatchObject({ code: "unavailable", model: "small" });
    expect(adapters.gpu.requests).toHaveLength(0);
    expect(adapters.cloud.requests).toHaveLength(0);
    expect(records.filter((r) => r.error?.code === "fallback-refused").map((r) => r.error!.message)).toEqual(["runs private, outside small's local boundary", "runs hosted, outside small's local boundary"]);
  });

  it("allowed to cross, it still never sends unlabeled content, nor content the fallback may not receive", async () => {
    const { llm, adapters } = fleet({ primary: { fallbacks: ["enclave", "frontier"], crossBoundaryFallback: true } }, { laptop: [down, down, down] });
    const small = llm.model("small", "development");
    await expect(small.generate({ messages: [{ role: "user", content: "x" }] }, { maxAttempts: 1 })).rejects.toMatchObject({ code: "unavailable", model: "small" });
    await expect(small.generate({ messages: [{ role: "user", content: "x" }], label: { markings: ["SECRET"] } }, { maxAttempts: 1 })).rejects.toMatchObject({ code: "unavailable", model: "small" });
    expect(adapters.gpu.requests).toHaveLength(0);
    expect(adapters.cloud.requests).toHaveLength(0);
    // CUI may go to the enclave model, which is cleared for it, and not to the frontier model.
    const r = await small.generate({ messages: [{ role: "user", content: "x" }], label: { markings: ["CUI"] } }, { maxAttempts: 1 });
    expect(r.record.model.id).toBe("enclave");
  });

  it("a request the model could not serve is not retried elsewhere: only unavailability falls back", async () => {
    const { llm, adapters } = fleet({}, { laptop: [{ error: new LlmError("invalid-request", "bad") }] });
    await expect(llm.model("small", "development").generate({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "invalid-request" });
    expect(adapters.gpu.requests).toHaveLength(0);
  });
});

describe("usage and cost", () => {
  it("are accounted in all, by model and by purpose, from configured prices only", async () => {
    const { llm } = fleet({}, { cloud: [{ text: "x".repeat(400) }] });
    await llm.model("frontier", "development").generate({ messages: [{ role: "user", content: "y".repeat(4000) }], purpose: "onboarding.propose" });
    await llm.model("small", "development").generate({ messages: [{ role: "user", content: "z" }], purpose: "explain" });
    const byPurpose = llm.usage.byPurpose();
    expect(byPurpose["onboarding.propose"]).toMatchObject({ calls: 1, outputTokens: 100, unpriced: 0 });
    expect(byPurpose["onboarding.propose"]!.costUsd).toBeCloseTo((byPurpose["onboarding.propose"]!.inputTokens * 4 + 100 * 20) / 1e6, 8);
    expect(byPurpose.explain).toMatchObject({ calls: 1, costUsd: 0, unpriced: 1 });
  });
});

describe("tools", () => {
  it("runTools validates generated arguments before running anything, returns errors to the model, and is bounded", async () => {
    const ran: unknown[] = [];
    const answers: ScriptedAnswer[] = [
      { toolCalls: [{ id: "1", name: "lookup", input: { id: 5 } }, { id: "2", name: "rm_rf", input: {} }] },
      { toolCalls: [{ id: "3", name: "lookup", input: { id: "A" } }] },
      "the answer"
    ];
    const { llm, adapters } = fleet({}, { gpu: answers });
    const tools = [{ name: "lookup", description: "d", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, execute: async (i: unknown) => (ran.push(i), { found: true }) }];
    const run = await runTools(llm.model("enclave", "development"), { messages: [{ role: "user", content: "go" }] }, tools);
    expect(run.result.text).toBe("the answer");
    expect(ran).toEqual([{ id: "A" }]);
    expect(run.calls.map((c) => [c.call.name, c.ok, c.error])).toEqual([
      ["lookup", false, "Invalid arguments: /id must be string"],
      ["rm_rf", false, 'There is no tool "rm_rf"'],
      ["lookup", true, undefined]
    ]);
    expect(adapters.gpu.requests[1]!.messages.filter((m) => m.role === "tool")).toHaveLength(2);

    const loop = fleet({}, { gpu: Array.from({ length: 5 }, () => ({ toolCalls: [{ id: "x", name: "lookup", input: { id: "A" } }] })) });
    await expect(runTools(loop.llm.model("enclave", "development"), { messages: [{ role: "user", content: "go" }] }, tools, { maxRounds: 3 })).rejects.toMatchObject({ code: "invalid-output" });
  });

  it("governed read tools read as the person and the model: the enclave model never receives the SECRET location, a commercial one receives nothing", async () => {
    const { runtime, registry } = await buildAirforceTestbed();
    const config = {
      format: "typesys.llm/1",
      providers: { enclave: { kind: "custom", environment: "private" }, cloud: { kind: "custom", environment: "hosted" } },
      models: {
        triage: { provider: "enclave", model: "t", uses: ["runtime"], audience: { id: "model:squadron-enclave/triage", roles: ["ai-enclave"], clearance: "CUI" }, capabilities: { tools: true } },
        general: { provider: "cloud", model: "g", uses: ["runtime"], audience: { id: "model:commercial-api/general", clearance: "UNCLASSIFIED" }, capabilities: { tools: true } }
      }
    } as unknown as LlmConfig;
    const llm = createLlm(config, { adapters: { enclave: scriptedAdapter(["unused"]), cloud: scriptedAdapter(["unused"]) } });
    const get = (model: string) => governedReadTools(runtime, demoIdentities.maintainer, llm.model(model, "runtime")).find((t) => t.name === "typesys_get_object")!;
    const enclave = (await get("triage").execute({ type: "airforce.Aircraft", id: "AF86-0147" })) as { values: Record<string, unknown> };
    expect(enclave.values).toMatchObject({ tailNumber: "AF86-0147", maintenanceStatus: "degraded" });
    expect(enclave.values).not.toHaveProperty("deploymentLocation");
    await expect(get("general").execute({ type: "airforce.Aircraft", id: "AF86-0147" })).rejects.toThrow("Not available");
    const rows = (await registry.listAuditEvents({ limit: 50 })).items;
    expect(rows.some((r) => r.details?.audience === "model:commercial-api/general" && r.decision === "deny")).toBe(true);
    // The person alone still reads the location: binding the model removed it.
    expect((await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.maintainer)).values).toHaveProperty("deploymentLocation");
    expect(withAudience(demoIdentities.maintainer, llm.model("triage", "runtime").info.audience).audience!.id).toBe("model:squadron-enclave/triage");
  });
});
