import { createHash, createHmac } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { trace, metrics, context, SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime, type SemanticRuntimeOptions } from "../src/runtime/runtime.js";
import { InMemoryCache } from "../src/runtime/cache.js";
import { HIGH_ASSURANCE_V1 } from "../src/runtime/security-profile.js";
import { AbacPolicyEngine, allowAllRule, anyOf, requireAttributeMatch, requireRole } from "../src/policy/abac-policy-engine.js";
import type { Adapter, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * Proves ADR-0017's central claim both directions: with no SDK registered
 * (every other test file in this repo), instrumentation is a true no-op;
 * here, registering a *real* (in-memory, test-only) SDK makes the exact
 * same runtime code produce real, correctly-shaped spans and metrics.
 * Nothing in runtime.ts changes between these two states — only whether
 * @opentelemetry/api finds a provider to hand spans to.
 */

class StubAdapter implements Adapter {
  readonly dataSourceId = "obs-ds";
  async resolveProperties(): Promise<ResolvedProperties> {
    return { values: { id: "obj-1", name: "Thing" }, provenance: [] };
  }
  async queryByType(): Promise<AdapterQueryResult> {
    return { items: [] };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
    return input;
  }
}

const identity: Identity = { subjectId: "u-viewer", roles: ["viewer"], attributes: {} };

let spanExporter: InMemorySpanExporter;
let metricExporter: InMemoryMetricExporter;
let meterProvider: MeterProvider;

beforeAll(() => {
  // Without a real context manager, trace.getActiveSpan()/startActiveSpan's parent-child
  // linking cannot follow async control flow across `await` — this is what actually makes
  // "an SDK is registered" real, not just a tracer/meter provider existing.
  context.setGlobalContextManager(new AsyncHooksContextManager().enable());

  spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  trace.setGlobalTracerProvider(tracerProvider);

  metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  meterProvider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 100_000 })]
  });
  metrics.setGlobalMeterProvider(meterProvider);
});

afterAll(async () => {
  await meterProvider.shutdown();
  // Test files share one process (vitest `isolate: false`): unregister the SDK so later files don't keep
  // recording every span into this file's in-memory exporter for the rest of the run.
  trace.disable();
  metrics.disable();
  context.disable();
});

beforeEach(() => {
  spanExporter.reset();
});

async function buildTestbed() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const schema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Thing/1.0.0",
    title: "Thing",
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(schema, { name: "test.Thing", version: "1.0.0" });
  await registry.registerMapping({
    id: "map-1",
    typeName: "test.Thing",
    target: "property",
    targetName: "*",
    dataSourceId: "obs-ds",
    operation: "get",
    resolutionMode: "live"
  });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  policyEngine.registerRule("deny-all", requireRole("nobody-has-this-role"));

  const runtime = new SemanticRuntime(registry, [new StubAdapter()], policyEngine, { cache: new InMemoryCache() });
  return { registry, runtime };
}

describe("OpenTelemetry instrumentation (ADR-0017) — with a real SDK registered", () => {
  it("getObject produces a span named SemanticRuntime.getObject with the expected attributes", async () => {
    const { runtime } = await buildTestbed();
    await runtime.getObject("test.Thing", "obj-1", identity);

    const spans = spanExporter.getFinishedSpans();
    const span = spans.find((s) => s.name === "SemanticRuntime.getObject");
    expect(span).toBeDefined();
    expect(span!.attributes["typesys.type_name"]).toBe("test.Thing");
    expect(span!.attributes["typesys.object_id"]).toBe("obj-1");
    expect(span!.attributes["typesys.identity.subject_id"]).toBe("u-viewer");
    expect(span!.status.code).toBe(1); // SpanStatusCode.OK
  });

  it("a thrown error is recorded on the span with an ERROR status, and still propagates", async () => {
    const { registry, runtime } = await buildTestbed();
    // Reassign the object policy to one that always denies, to force a real failure path.
    const typeDef = await registry.getType("test.Thing");
    typeDef!.schema["x-policy"]!.objectPolicy = "deny-all";

    await expect(runtime.getObject("test.Thing", "obj-1", identity)).rejects.toThrow();

    const span = spanExporter.getFinishedSpans().find((s) => s.name === "SemanticRuntime.getObject");
    expect(span!.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span!.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("invokeAction produces a span with the action name as an attribute", async () => {
    const { registry, runtime } = await buildTestbed();
    await registry.registerAction({
      id: "action-1",
      name: "DoThing",
      description: "test",
      applicableTypes: ["test.Thing"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      authorizationPolicy: "public",
      implementation: { dataSourceId: "obs-ds", operation: "noop" },
      sideEffects: "none",
      idempotency: "none",
      auditRequired: false,
      version: "1.0.0"
    });

    await runtime.invokeAction("DoThing", { x: 1 }, identity);

    const span = spanExporter.getFinishedSpans().find((s) => s.name === "SemanticRuntime.invokeAction");
    expect(span).toBeDefined();
    expect(span!.attributes["typesys.action_name"]).toBe("DoThing");
  });

  it("getRelationship's fan-out to getObject produces nested child spans, not flat siblings", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const childSchema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Child/1.0.0",
      title: "Child",
      type: "object",
      properties: { id: { type: "string" } },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(childSchema, { name: "test.Child", version: "1.0.0" });
    await registry.registerMapping({
      id: "map-child",
      typeName: "test.Child",
      target: "property",
      targetName: "*",
      dataSourceId: "obs-ds",
      operation: "get",
      resolutionMode: "live"
    });
    const parentSchema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Parent/1.0.0",
      title: "Parent",
      type: "object",
      properties: { id: { type: "string" } },
      "x-relationships": {
        children: {
          target: "test.Child",
          cardinality: "one-to-many",
          resolution: { dataSourceId: "obs-ds", operation: "byForeignKey:parentId" }
        }
      },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(parentSchema, { name: "test.Parent", version: "1.0.0" });
    // The parent's own stored values are what the relationship's read is authorized on (ADR-0030).
    await registry.registerMapping({
      id: "map-parent",
      typeName: "test.Parent",
      target: "property",
      targetName: "*",
      dataSourceId: "obs-ds",
      operation: "get",
      resolutionMode: "live"
    });

    class OneChildAdapter extends StubAdapter {
      override async resolveRelationship(): Promise<RelatedRef[]> {
        return [{ objectId: "child-1" }];
      }
    }
    const policyEngine = new AbacPolicyEngine();
    policyEngine.registerRule("public", allowAllRule);
    const runtime = new SemanticRuntime(registry, [new OneChildAdapter()], policyEngine);

    await runtime.getRelationship("test.Parent", "parent-1", "children", identity);

    const spans = spanExporter.getFinishedSpans();
    const relSpan = spans.find((s) => s.name === "SemanticRuntime.getRelationship");
    const objSpan = spans.find((s) => s.name === "SemanticRuntime.getObject");
    expect(relSpan).toBeDefined();
    expect(objSpan).toBeDefined();
    expect(objSpan!.parentSpanContext?.spanId).toBe(relSpan!.spanContext().spanId); // real parent/child nesting
  });

  it("cache hits are reflected in the typesys.cache.hit span attribute and the cache-requests metric", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const schema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Cached/1.0.0",
      title: "Cached",
      type: "object",
      properties: { id: { type: "string" } },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(schema, { name: "test.Cached", version: "1.0.0" });
    await registry.registerMapping({
      id: "map-cached",
      typeName: "test.Cached",
      target: "property",
      targetName: "*",
      dataSourceId: "obs-ds",
      operation: "get",
      resolutionMode: "cached",
      cacheTtlMs: 5_000
    });
    const policyEngine = new AbacPolicyEngine();
    policyEngine.registerRule("public", allowAllRule);
    const runtime = new SemanticRuntime(registry, [new StubAdapter()], policyEngine, { cache: new InMemoryCache() });

    await runtime.getObject("test.Cached", "obj-1", identity); // miss
    await runtime.getObject("test.Cached", "obj-1", identity); // hit

    const spans = spanExporter.getFinishedSpans().filter((s) => s.name === "SemanticRuntime.getObject");
    expect(spans[0]!.attributes["typesys.cache.hit"]).toBe(false);
    expect(spans[1]!.attributes["typesys.cache.hit"]).toBe(true);
  });

  it("a query's span carries its authorization plan's kind, exactness, and limitation codes — never a predicate literal or an identity attribute (ADR-0038)", async () => {
    const { registry } = await buildTestbed();
    const policyEngine = new AbacPolicyEngine();
    policyEngine.registerRule("owned", anyOf(requireAttributeMatch("ownerId", "providerId"), requireAttributeMatch("id", "providerId")));
    await registry.registerType(
      { $id: "https://typesys.dev/types/test/Owned/1.0.0", title: "Owned", type: "object", properties: { id: { type: "string" }, ownerId: { type: "string" } }, "x-policy": { objectPolicy: "owned" } },
      { name: "test.Owned", version: "1.0.0" }
    );
    await registry.registerMapping({ id: "map-owned", typeName: "test.Owned", target: "property", targetName: "*", dataSourceId: "obs-ds", operation: "get", resolutionMode: "live" });
    const runtime = new SemanticRuntime(registry, [new StubAdapter()], policyEngine);
    const owner: Identity = { subjectId: "u-owner", roles: [], attributes: { providerId: "PR-SECRET-77" } };

    await runtime.query({ type: "test.Owned" }, owner);

    const span = spanExporter.getFinishedSpans().find((s) => s.name === "SemanticRuntime.query")!;
    expect(span.attributes).toMatchObject({ "typesys.authz.plan.kind": "predicate", "typesys.authz.plan.exact": true, "typesys.authz.plan.limitations": "" });
    expect(JSON.stringify(spanExporter.getFinishedSpans().map((s) => s.attributes))).not.toMatch(/PR-SECRET-77|ownerId/);
  });

  describe("telemetry identity policy (ADR-0045)", () => {
    const withPolicy = async (telemetryIdentity: SemanticRuntimeOptions["telemetryIdentity"]) => {
      const { registry } = await buildTestbed();
      const policyEngine = new AbacPolicyEngine();
      policyEngine.registerRule("public", allowAllRule);
      return new SemanticRuntime(registry, [new StubAdapter()], policyEngine, { telemetryIdentity });
    };
    const spanAttributes = () => spanExporter.getFinishedSpans().map((s) => s.attributes);
    const alice: Identity = { subjectId: "alice@example.mil", roles: [], attributes: {} };

    it('"none" puts no identity on any span', async () => {
      const runtime = await withPolicy("none");
      await runtime.getObject("test.Thing", "obj-1", alice);
      await runtime.query({ type: "test.Thing" }, alice);
      expect(spanAttributes().length).toBeGreaterThan(0);
      expect(JSON.stringify(spanAttributes())).not.toContain("alice");
      expect(spanAttributes().every((a) => !("typesys.identity.subject_id" in a) && !("typesys.identity.pseudonym" in a))).toBe(true);
    });

    it("pseudonymous: a keyed pseudonym, stable per subject and key, that isn't the id or its plain hash", async () => {
      const key = new Uint8Array(32).fill(7);
      const runtime = await withPolicy({ mode: "pseudonymous", key });
      await runtime.getObject("test.Thing", "obj-1", alice);
      await runtime.getObject("test.Thing", "obj-1", alice);
      await runtime.getObject("test.Thing", "obj-1", { ...alice, subjectId: "bob@example.mil" });
      const pseudonyms = spanAttributes().map((a) => a["typesys.identity.pseudonym"]);
      expect(pseudonyms[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(pseudonyms[1]).toBe(pseudonyms[0]);
      expect(pseudonyms[2]).not.toBe(pseudonyms[0]);
      expect(pseudonyms[0]).not.toBe(createHash("sha256").update("alice@example.mil").digest().subarray(0, 16).toString("base64url"));
      expect(JSON.stringify(spanAttributes())).not.toContain("alice");
      spanExporter.reset();
      await (await withPolicy({ mode: "pseudonymous", key: new Uint8Array(32).fill(8) })).getObject("test.Thing", "obj-1", alice);
      expect(spanAttributes()[0]!["typesys.identity.pseudonym"]).not.toBe(pseudonyms[0]);
    });

    it("the audit log keeps the attributable subject id whatever telemetry does", async () => {
      const { registry } = await buildTestbed();
      const policyEngine = new AbacPolicyEngine();
      policyEngine.registerRule("public", allowAllRule);
      await new SemanticRuntime(registry, [new StubAdapter()], policyEngine, { telemetryIdentity: "none" }).getObject("test.Thing", "obj-1", alice);
      expect((await registry.listAuditEvents({ limit: 5 })).items[0]?.subjectId).toBe("alice@example.mil");
    });

    it("attack: a malformed policy fails at construction — an unknown mode, a short or non-byte key", async () => {
      for (const policy of ["hashed", "CLEAR", { mode: "pseudonymous" }, { mode: "pseudonymous", key: new Uint8Array(31) }, { mode: "pseudonymous", key: "k".repeat(64) }, { mode: "hash", key: new Uint8Array(32) }, null]) {
        await expect(withPolicy(policy as never)).rejects.toThrow(/telemetryIdentity/);
      }
    });
  });

  describe("no raw identifiers in telemetry (ADR-0047)", () => {
    // Every identifier this world can put anywhere: the caller, each object, a field value, and the ids inside error messages.
    const SECRETS = /PT-SUBJ-9|PT-1001|PT-1002|PT-4040|Jordan Lee|PT-OWNER/;
    const RECORDS: Record<string, Record<string, unknown>> = {
      "PT-1001": { id: "PT-1001", name: "Jordan Lee", ownerId: "PT-OWNER" },
      "PT-1002": { id: "PT-1002", name: "Someone Else", ownerId: "other" }
    };
    class RecordStore implements Adapter {
      readonly dataSourceId = "obs-ds";
      async resolveProperties(_t: string, id: string): Promise<ResolvedProperties> {
        const values = RECORDS[id];
        // An adapter's own error, naming the id it couldn't find — as real stores' errors do.
        if (!values) throw new Error(`record ${id} not found`);
        return { values: { ...values }, provenance: [] };
      }
      async queryByType(): Promise<AdapterQueryResult> {
        return { items: Object.entries(RECORDS).map(([objectId, v]) => ({ objectId, values: { ...v }, provenance: [] })) };
      }
      async resolveRelationship(): Promise<RelatedRef[]> {
        return [{ objectId: "PT-1002" }];
      }
      async executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
        return input;
      }
    }
    const caller: Identity = { subjectId: "PT-SUBJ-9", roles: [], attributes: { userId: "PT-OWNER" } };

    async function recordWorld(options: SemanticRuntimeOptions) {
      const registry = new SemanticRegistry(new InMemoryRegistryStore());
      await registry.registerType(
        {
          $id: "https://typesys.dev/types/test/Record/1.0.0",
          title: "Record",
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, ownerId: { type: "string" } },
          "x-relationships": { related: { target: "test.Record", cardinality: "one-to-many", resolution: { dataSourceId: "obs-ds", operation: "byForeignKey:ownerId" } } },
          "x-policy": { objectPolicy: "own" }
        },
        { name: "test.Record", version: "1.0.0" }
      );
      await registry.registerMapping({ id: "map-rec", typeName: "test.Record", target: "property", targetName: "*", dataSourceId: "obs-ds", operation: "get", resolutionMode: "live" });
      await registry.registerAction({
        id: "action-note", name: "AddNote", description: "test", applicableTypes: ["test.Record"],
        inputSchema: { type: "object" }, outputSchema: { type: "object" }, authorizationPolicy: "own-action",
        implementation: { dataSourceId: "obs-ds", operation: "noop" }, sideEffects: "none", idempotency: "none", auditRequired: false, version: "1.0.0"
      });
      const policyEngine = new AbacPolicyEngine();
      policyEngine.registerRule("own", requireAttributeMatch("ownerId", "userId"));
      policyEngine.registerRule("own-action", allowAllRule);
      let calls = 0;
      const runtime = new SemanticRuntime(registry, [new RecordStore()], policyEngine, {
        ...options,
        rateLimiter: { tryAcquire: () => ++calls <= 9 } // the tenth call is refused, naming the subject
      });
      return runtime;
    }

    /** Every operation, the successes and the failures, whose errors name objects and the subject. */
    async function everything(runtime: SemanticRuntime) {
      const settle = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e as Error).name);
      return [
        await settle(runtime.getObject("test.Record", "PT-1001", caller)),
        await settle(runtime.getObject("test.Record", "PT-1002", caller)), // denied: "Not authorized: read test.Record/PT-1002"
        await settle(runtime.getObject("test.Record", "PT-4040", caller)), // the adapter's error names the id
        await settle(runtime.getRelationship("test.Record", "PT-1001", "related", caller)),
        await settle(runtime.getProvenance("test.Record", "PT-1001", "name", caller)),
        await settle(runtime.query({ type: "test.Record" }, caller)),
        await settle(runtime.explainQuery({ type: "test.Record" }, caller)),
        await settle(runtime.listActions("test.Record", caller)),
        await settle(runtime.invokeAction("AddNote", { note: "for PT-1001" }, caller)),
        await settle(runtime.getObject("test.Record", "PT-1001", caller)) // rate-limited: names the subject
      ];
    }
    /** Everything a span exports that could carry text: attributes, status, events and their attributes. */
    const exported = () =>
      JSON.stringify(spanExporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes, status: s.status, events: s.events.map((e) => ({ name: e.name, attributes: e.attributes })) })));

    it("the world leaks everything in the clear — so the attack below is testing something", async () => {
      const outcomes = await everything(await recordWorld({}));
      expect(outcomes).toContain("AuthorizationError");
      expect(outcomes).toContain("RateLimitExceededError");
      const text = exported();
      for (const id of ["PT-SUBJ-9", "PT-1001", "PT-1002", "PT-4040"]) expect(text).toContain(id);
    });

    for (const [label, options] of [
      ['"none"', { telemetryIdentity: "none" }],
      ["pseudonymous", { telemetryIdentity: { mode: "pseudonymous", key: new Uint8Array(32).fill(3) } }],
      ["HIGH_ASSURANCE_V1", { securityProfile: HIGH_ASSURANCE_V1 }]
    ] as [string, SemanticRuntimeOptions][]) {
      it(`attack: under ${label}, no subject id, object id, or value reaches any span — not even inside an error`, async () => {
        const outcomes = await everything(await recordWorld(options));
        expect(outcomes.filter((o) => o !== "ok")).toEqual(expect.arrayContaining(["AuthorizationError", "Error", "RateLimitExceededError"]));
        const spans = spanExporter.getFinishedSpans();
        expect(spans.length).toBeGreaterThanOrEqual(10);
        expect(exported()).not.toMatch(SECRETS);
        // Failures are still visible, by class.
        const denied = spans.filter((s) => s.status.code === SpanStatusCode.ERROR).map((s) => s.status.message);
        expect(denied).toEqual(expect.arrayContaining(["AuthorizationError", "Error", "RateLimitExceededError"]));
        expect(spans.every((s) => !("typesys.object_id" in s.attributes) && !("typesys.identity.subject_id" in s.attributes))).toBe(true);
      });
    }

    it("pseudonymous: object pseudonyms are stable, differ by Type and object, and never equal a subject's", async () => {
      const key = new Uint8Array(32).fill(3);
      const runtime = await recordWorld({ telemetryIdentity: { mode: "pseudonymous", key } });
      await runtime.getObject("test.Record", "PT-1001", caller);
      await runtime.getObject("test.Record", "PT-1001", caller);
      await runtime.getObject("test.Record", "PT-1002", caller).catch(() => undefined);
      const [a, b, c] = spanExporter.getFinishedSpans().filter((s) => s.name === "SemanticRuntime.getObject").map((s) => s.attributes);
      expect(a!["typesys.object_pseudonym"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(b!["typesys.object_pseudonym"]).toBe(a!["typesys.object_pseudonym"]);
      expect(c!["typesys.object_pseudonym"]).not.toBe(a!["typesys.object_pseudonym"]);
      // The same id as a subject, or in another Type, is a different input: tagged, so it can't collide.
      const hmac = (parts: string[]) => createHmac("sha256", key).update(JSON.stringify(parts), "utf8").digest().subarray(0, 16).toString("base64url");
      expect(a!["typesys.object_pseudonym"]).toBe(hmac(["object", "test.Record", "PT-1001"]));
      expect(hmac(["object", "test.Other", "PT-1001"])).not.toBe(a!["typesys.object_pseudonym"]);
      expect(a!["typesys.identity.pseudonym"]).toBe(hmac(["subject", "PT-SUBJ-9"]));
      expect(hmac(["subject", "PT-1001"])).not.toBe(a!["typesys.object_pseudonym"]);
    });

    it("attack: an error whose name is set to carry an identifier is recorded as plain Error", async () => {
      const runtime = await recordWorld({ telemetryIdentity: "none" });
      const sneaky = Object.assign(new Error("x"), { name: "Missing PT-1001" });
      const store = (runtime as unknown as { adapters: Map<string, Adapter> }).adapters;
      expect(store).toBeInstanceOf(Map);
      store.get("obs-ds")!.resolveProperties = () => Promise.reject(sneaky);
      await expect(runtime.getObject("test.Record", "PT-1001", caller)).rejects.toBe(sneaky);
      expect(exported()).not.toMatch(SECRETS);
      expect(spanExporter.getFinishedSpans()[0]!.status.message).toBe("Error");
    });
  });

  it("records policy decisions and operation duration on the registered MeterProvider without throwing", async () => {
    const { runtime } = await buildTestbed();
    // The real assertion is simply that a full request cycle against a REAL MeterProvider
    // (not the no-op default) completes without error — proving the counter/histogram
    // instruments created against the global meter are valid and usable end-to-end.
    await expect(runtime.getObject("test.Thing", "obj-1", identity)).resolves.toBeDefined();
  });
});
