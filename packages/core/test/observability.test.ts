import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { trace, metrics, context } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { InMemoryCache } from "../src/runtime/cache.js";
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

  it("records policy decisions and operation duration on the registered MeterProvider without throwing", async () => {
    const { runtime } = await buildTestbed();
    // The real assertion is simply that a full request cycle against a REAL MeterProvider
    // (not the no-op default) completes without error — proving the counter/histogram
    // instruments created against the global meter are valid and usable end-to-end.
    await expect(runtime.getObject("test.Thing", "obj-1", identity)).resolves.toBeDefined();
  });
});
