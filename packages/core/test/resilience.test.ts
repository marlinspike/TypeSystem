import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AdapterResilience, isRetryableError, type ResiliencePolicy } from "../src/runtime/resilience.js";
import { AdapterTimeoutError, CircuitOpenError } from "../src/runtime/errors.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import type { Adapter, AdapterCallOptions, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition, Idempotency } from "../src/model/action.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

function transient(message = "transient"): Error {
  return Object.assign(new Error(message), { retryable: true });
}

/** Rejects immediately if the signal is (or becomes) aborted; otherwise resolves after `ms`. */
function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

describe("isRetryableError", () => {
  it("treats only genuine transient signals as retryable", () => {
    expect(isRetryableError(new AdapterTimeoutError("slow"))).toBe(true);
    expect(isRetryableError(Object.assign(new Error(), { retryable: true }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error(), { code: "ECONNRESET" }))).toBe(true);
  });

  it("never retries deterministic or explicitly-non-retryable failures", () => {
    expect(isRetryableError(new Error("plain"))).toBe(false);
    expect(isRetryableError(Object.assign(new Error(), { retryable: false }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error(), { code: "23505" }))).toBe(false); // a pg unique-violation
    expect(isRetryableError(new CircuitOpenError("open"))).toBe(false);
  });
});

describe("AdapterResilience", () => {
  const fast: ResiliencePolicy = { retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } };

  it("is a no-op when the policy is empty, passing an undefined signal", async () => {
    const r = new AdapterResilience();
    expect(r.isNoop).toBe(true);
    let seen: AbortSignal | undefined = {} as AbortSignal;
    const out = await r.run("ds", true, (signal) => {
      seen = signal;
      return Promise.resolve("ok");
    });
    expect(out).toBe("ok");
    expect(seen).toBeUndefined();
  });

  it("times out a hung call with AdapterTimeoutError and aborts its signal", async () => {
    const r = new AdapterResilience({ callTimeoutMs: 20 });
    let aborted = false;
    await expect(
      r.run("ds", false, (signal) => {
        signal?.addEventListener("abort", () => (aborted = true), { once: true });
        return abortableWait(1000, signal);
      })
    ).rejects.toBeInstanceOf(AdapterTimeoutError);
    expect(aborted).toBe(true);
  });

  it("retries a retryable failure and returns the eventual success", async () => {
    const r = new AdapterResilience(fast);
    let attempts = 0;
    const out = await r.run("ds", true, () => {
      attempts++;
      if (attempts < 3) throw transient();
      return Promise.resolve("recovered");
    });
    expect(out).toBe("recovered");
    expect(attempts).toBe(3);
  });

  it("gives up with the last error after maxAttempts", async () => {
    const r = new AdapterResilience(fast);
    let attempts = 0;
    await expect(
      r.run("ds", true, () => {
        attempts++;
        throw transient(`fail ${attempts}`);
      })
    ).rejects.toThrow("fail 3");
    expect(attempts).toBe(3);
  });

  it("does not retry a non-retryable error", async () => {
    const r = new AdapterResilience(fast);
    let attempts = 0;
    await expect(
      r.run("ds", true, () => {
        attempts++;
        throw new Error("deterministic");
      })
    ).rejects.toThrow("deterministic");
    expect(attempts).toBe(1);
  });

  it("does not retry when the call is marked not retryable, even for a retryable error", async () => {
    const r = new AdapterResilience(fast);
    let attempts = 0;
    await expect(
      r.run("ds", false, () => {
        attempts++;
        throw transient();
      })
    ).rejects.toThrow("transient");
    expect(attempts).toBe(1); // this is exactly how a non-idempotent Action is protected
  });

  it("opens the circuit after the failure threshold, fast-fails, then half-opens after cooldown", async () => {
    let clock = 0;
    const now = () => clock;
    const r = new AdapterResilience({ circuitBreaker: { failureThreshold: 2, cooldownMs: 1000 } }, now);

    let calls = 0;
    let shouldFail = true;
    const call = () =>
      r.run("ds", false, () => {
        calls++;
        if (shouldFail) throw transient();
        return Promise.resolve("ok");
      });

    // Two failures trip it open.
    await expect(call()).rejects.toThrow("transient");
    await expect(call()).rejects.toThrow("transient");
    expect(calls).toBe(2);

    // While open, the call fast-fails WITHOUT invoking the underlying function.
    await expect(call()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(2);

    // After the cooldown, one half-open probe is allowed; a success closes the breaker.
    clock += 1001;
    shouldFail = false;
    await expect(call()).resolves.toBe("ok"); // the probe (call #3 of the function)
    expect(calls).toBe(3);
    await expect(call()).resolves.toBe("ok"); // closed again, calls pass normally
    expect(calls).toBe(4);
  });
});

// ---- Runtime-level wiring (the proxy in SemanticRuntime.getAdapter) ----

const identity: Identity = { subjectId: "u1", roles: [], attributes: {} };

class ControllableAdapter implements Adapter {
  readonly dataSourceId = "ds";
  resolveCalls = 0;
  actionCalls = 0;
  failuresRemaining = 0;
  hangMs = 0;

  async resolveProperties(
    _typeName: string,
    objectId: string,
    _propertyNames: string[],
    opts?: AdapterCallOptions
  ): Promise<ResolvedProperties> {
    this.resolveCalls++;
    if (this.hangMs > 0) await abortableWait(this.hangMs, opts?.signal);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw transient();
    }
    return { values: { id: objectId }, provenance: [] };
  }

  queryByType(): Promise<AdapterQueryResult> {
    return Promise.resolve({ items: [] });
  }

  resolveRelationship(): Promise<RelatedRef[]> {
    return Promise.resolve([]);
  }

  async executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
    this.actionCalls++;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw transient();
    }
    return input;
  }
}

function actionDef(idempotency: Idempotency): ActionDefinition {
  return {
    id: "act-do",
    name: "test.do",
    description: "test action",
    applicableTypes: ["test.Thing"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    authorizationPolicy: "public",
    implementation: { dataSourceId: "ds", operation: "op" },
    sideEffects: "external",
    idempotency,
    auditRequired: false,
    version: "1.0.0"
  };
}

async function setup(resilience?: ResiliencePolicy) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const schema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Thing/1.0.0",
    title: "Thing",
    type: "object",
    properties: { id: { type: "string" } },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(schema, { name: "test.Thing", version: "1.0.0" });
  await registry.registerMapping({
    id: "map-thing",
    typeName: "test.Thing",
    target: "property",
    targetName: "*",
    dataSourceId: "ds",
    operation: "get",
    resolutionMode: "live"
  });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  const adapter = new ControllableAdapter();
  const runtime = new SemanticRuntime(registry, [adapter], policyEngine, { resilience });
  return { registry, runtime, adapter };
}

describe("SemanticRuntime adapter-call resilience (ADR-0026)", () => {
  it("times a slow read out through a public runtime method", async () => {
    const { runtime, adapter } = await setup({ callTimeoutMs: 20 });
    adapter.hangMs = 1000;
    await expect(runtime.getObject("test.Thing", "t1", identity)).rejects.toBeInstanceOf(AdapterTimeoutError);
  });

  it("retries a transient read failure and succeeds", async () => {
    const { runtime, adapter } = await setup({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    adapter.failuresRemaining = 2;
    const obj = await runtime.getObject("test.Thing", "t1", identity);
    expect(obj.values.id).toBe("t1");
    expect(adapter.resolveCalls).toBe(3);
  });

  it("retries an idempotent Action but never a non-idempotent one", async () => {
    // Non-idempotent: one transient failure is fatal — the write is not re-issued.
    const nonIdem = await setup({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    await nonIdem.registry.registerAction(actionDef("none"));
    nonIdem.adapter.failuresRemaining = 1;
    await expect(nonIdem.runtime.invokeAction("test.do", {}, identity)).rejects.toThrow("transient");
    expect(nonIdem.adapter.actionCalls).toBe(1);

    // Idempotent: the same transient failure is retried to success.
    const idem = await setup({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    await idem.registry.registerAction(actionDef("natural"));
    idem.adapter.failuresRemaining = 1;
    await expect(idem.runtime.invokeAction("test.do", {}, identity)).resolves.toBeDefined();
    expect(idem.adapter.actionCalls).toBe(2);
  });

  it("still resolves normally with no resilience policy (unchanged default behavior)", async () => {
    const { runtime, adapter } = await setup();
    const obj = await runtime.getObject("test.Thing", "t1", identity);
    expect(obj.values.id).toBe("t1");
    expect(adapter.resolveCalls).toBe(1);
  });
});
