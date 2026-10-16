import { describe, expect, it } from "vitest";
import { createLlm, LlmError, scriptedAdapter, type CallRecord, type LlmConfig, type ScriptedAnswer } from "../src/index.js";

/**
 * Content read for one model's audience goes to that audience only, and a
 * selection's requirements hold for its fallbacks too (ADR-0075; M3 review
 * H2 and M3).
 */
const down: ScriptedAnswer = { error: new LlmError("unavailable", "down") };

function pair(primary: Record<string, unknown>, fallback: Record<string, unknown>, answers: Record<string, ScriptedAnswer[]>) {
  const config = {
    format: "typesys.llm/1",
    providers: { a: { kind: "custom", environment: "private" }, b: { kind: "custom", environment: "private" } },
    models: {
      primary: { provider: "a", model: "p", uses: ["development"], fallbacks: ["fallback"], ...primary },
      fallback: { provider: "b", model: "f", uses: ["development"], ...fallback }
    }
  } as unknown as LlmConfig;
  const records: CallRecord[] = [];
  const llm = createLlm(config, { adapters: { a: scriptedAdapter(answers.a ?? ["ok"]), b: scriptedAdapter(answers.b ?? ["from the fallback"]) }, onCall: (r) => records.push(r) });
  return { llm, records };
}

describe("content released for one audience", () => {
  it("is not sent to a fallback with another audience, whatever its label", async () => {
    const { llm, records } = pair({ audience: { roles: ["viewer"] } }, {}, { a: [down] });
    const model = llm.model("primary", "development");
    const err = await model.generate({ messages: [{ role: "user", content: "what the viewer may see" }], label: { markings: [] }, releasedFor: model.info.audience.id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(records.some((r) => r.model.id === "fallback" && !r.error)).toBe(false);
    // Refused when the fallback is chosen, before it is asked: the move itself is recorded as refused.
    expect(records.some((r) => r.model.id === "fallback" && r.error?.code === "fallback-refused")).toBe(true);
    // Without the binding, the same label admits the fallback: the binding is what stops it.
    expect((await model.generate({ messages: [{ role: "user", content: "public" }], label: { markings: [] } })).text).toBe("from the fallback");
  });

  it("is sent to a fallback the deployment says is the same audience", async () => {
    const { llm } = pair({ audience: { id: "team-models", roles: ["viewer"] } }, { audience: { id: "team-models", roles: ["viewer"] } }, { a: [down] });
    const model = llm.model("primary", "development");
    expect((await model.generate({ messages: [{ role: "user", content: "x" }], label: { markings: [] }, releasedFor: "team-models" })).text).toBe("from the fallback");
  });

  it("is refused by a model called directly with another audience", async () => {
    const { llm } = pair({}, {}, {});
    const err = await llm.model("fallback", "development").generate({ messages: [{ role: "user", content: "x" }], label: { markings: [] }, releasedFor: "model:primary" }).catch((e: unknown) => e);
    expect((err as LlmError).code).toBe("release-refused");
  });
});

describe("a selection", () => {
  it("falls back only to models that meet its requirements", async () => {
    const { llm, records } = pair({ retention: { prompts: "zero-data-retention", training: "no" } }, { retention: { prompts: "provider-default", training: "no" } }, { a: [down] });
    const { model, considered } = llm.select({ use: "development", retention: ["zero-data-retention"] });
    expect(model.id).toBe("primary");
    expect(considered).toContainEqual({ id: "fallback", rejected: "retention is provider-default" });
    await expect(model.generate({ messages: [{ role: "user", content: "x" }], label: { markings: [] } })).rejects.toBeInstanceOf(LlmError);
    expect(records.some((r) => r.model.id === "fallback")).toBe(false);
  });
});

describe("configuration and discovery (M3 review L1, L2)", () => {
  it("only a 127/8 address, ::1 or localhost is this machine; a name starting with 127 is not", async () => {
    const { resolveConfig } = await import("../src/index.js");
    const r = resolveConfig({ format: "typesys.llm/1", providers: { trick: { kind: "ollama", baseUrl: "http://127.attacker.example:11434/v1", environment: "local" }, real: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1" } }, models: {} });
    expect(r.diagnostics.map((d) => `${d.at} ${d.code}`)).toEqual(["providers/trick/environment environment-mismatch"]);
    expect(r.providers.get("real")!.environment).toBe("local");
  });

  it("a discovery error never carries a header secret", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `bad key ${String(req.headers["x-tenant-key"])}` }));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      const config = { format: "typesys.llm/1", providers: { o: { kind: "ollama", baseUrl: `http://127.0.0.1:${port}/v1`, headers: { "x-tenant-key": { env: "TENANT_KEY" } } } }, models: {} } as unknown as LlmConfig;
      const err = await createLlm(config, { secrets: (n) => (n === "TENANT_KEY" ? "tenant-SuperSecret" : undefined) }).discover("o").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(JSON.stringify({ message: (err as Error).message, err })).not.toContain("SuperSecret");
    } finally {
      server.close();
    }
  });
});
