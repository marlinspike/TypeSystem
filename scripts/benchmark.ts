#!/usr/bin/env -S npx tsx
/**
 * Measures SemanticRuntime overhead (policy evaluation, audit logging,
 * tracing spans, provenance bookkeeping — everything the runtime does on
 * top of "go fetch some data") in two configurations:
 *
 *   1. In-memory adapter — isolates runtime overhead from any real I/O
 *      latency. This is the number that answers "what does going through
 *      the semantic layer cost, on its own?"
 *   2. `@typesys/adapter-postgres` against a real local database — the
 *      number that includes actual network/DB round trips, so it reads
 *      low if and only if Postgres itself is fast on this machine. It is
 *      NOT a production throughput claim for any particular deployment
 *      (that depends on network topology, DB tier, connection pooling,
 *      concurrent load, etc.) — it exists to catch regressions on this
 *      machine over time, not to be compared against the in-memory
 *      numbers row-for-row: the two use deliberately different domains
 *      (airforce vs. a synthetic `bench.Widget`/`bench.Part` schema)
 *      because the airforce domain's `readinessStatus`/`needsAttention`
 *      computed properties add their own async resolution cost that has
 *      nothing to do with which adapter is underneath it. Compare a
 *      backend's numbers against its own history, not against the other
 *      backend's row.
 *
 *      `airforce.Aircraft`'s "query + filter" number in particular is
 *      dominated by `needsAttention` (ADR-0022): every "operational"
 *      aircraft in the result (the filter used here selects exactly
 *      those) makes two live `queryByType` calls into the maintenance
 *      adapter to check for open work orders — even with the mock REST
 *      client's simulated latency set to 0, each call still yields a real
 *      macrotask hop (`setTimeout(resolve, 0)`), and that cost multiplies
 *      across every matching aircraft in the page, bounded by
 *      `maxConcurrency`. This is a genuine, worth-knowing cost of pattern
 *      2 in docs/how-to/combine-multiple-sources.md, not a regression to
 *      chase — see ADR-0022's Consequences.
 *
 * Skips the Postgres section cleanly (same convention as the rest of the
 * repo) when DATABASE_URL/PGHOST isn't set.
 */
import {
  SemanticRegistry,
  SemanticRuntime,
  InMemoryRegistryStore,
  AbacPolicyEngine,
  allowAllRule,
  requireRole,
  buildRuntime,
  coreManifest,
  type SemanticTypeSchema,
  type Identity
} from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { MockRestAdapter, MockRestClient } from "@typesys/adapter-mock-rest";
import { airforceManifest, AIRCRAFT_DATA_SOURCE_ID, MAINTENANCE_DATA_SOURCE_ID } from "@typesys/domain-airforce";

const N = 500;
const identity: Identity = { subjectId: "bench-user", roles: ["maintainer", "viewer"], attributes: {} };

interface Sample {
  label: string;
  backend: string;
  durationsMs: number[];
}

async function timeIt(label: string, backend: string, n: number, fn: () => Promise<unknown>): Promise<Sample> {
  const durationsMs: number[] = [];
  // A handful of untimed warm-up calls so JIT/connection setup doesn't skew p50.
  for (let i = 0; i < 5; i++) await fn();
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    await fn();
    const end = process.hrtime.bigint();
    durationsMs.push(Number(end - start) / 1e6);
  }
  return { label, backend, durationsMs };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function report(samples: Sample[]): void {
  const rows = samples.map((s) => {
    const sorted = [...s.durationsMs].sort((a, b) => a - b);
    const totalMs = s.durationsMs.reduce((a, b) => a + b, 0);
    return {
      backend: s.backend,
      operation: s.label,
      p50: percentile(sorted, 50).toFixed(3),
      p95: percentile(sorted, 95).toFixed(3),
      p99: percentile(sorted, 99).toFixed(3),
      "ops/sec": (1000 / (totalMs / sorted.length)).toFixed(0)
    };
  });
  console.table(rows);
}

async function benchmarkInMemory(): Promise<Sample[]> {
  const inMemoryAdapter = new InMemoryRepositoryAdapter(AIRCRAFT_DATA_SOURCE_ID, "airforce-repo");
  const mockRestClient = new MockRestClient(0);
  const mockRestAdapter = new MockRestAdapter(MAINTENANCE_DATA_SOURCE_ID, mockRestClient, {
    maintenanceEventType: "airforce.MaintenanceEvent",
    workOrderType: "airforce.WorkOrder"
  });

  const aircraft = Array.from({ length: 200 }, (_, i) => ({
    objectId: `AC-${i}`,
    values: {
      id: `AC-${i}`,
      tailNumber: `AC-${i}`,
      model: "F-16C",
      maintenanceStatus: i % 3 === 0 ? "down" : "operational"
    }
  }));
  inMemoryAdapter.seed("airforce.Aircraft", aircraft);
  const components = Array.from({ length: 400 }, (_, i) => ({
    objectId: `COMP-${i}`,
    values: { id: `COMP-${i}`, aircraftId: `AC-${i % 200}`, name: `Component ${i}` }
  }));
  inMemoryAdapter.seed("airforce.Component", components);

  const { registry, runtime } = await buildRuntime({
    manifests: [coreManifest, airforceManifest],
    adapters: [inMemoryAdapter, mockRestAdapter],
    policyRules: {
      "airforce.read-aircraft": requireRole("maintainer", "viewer"),
      "airforce.maintainer-only": requireRole("maintainer")
    }
  });
  void registry;

  return [
    await timeIt("getObject", "in-memory adapter", N, () => runtime.getObject("airforce.Aircraft", "AC-0", identity)),
    await timeIt("getRelationship (one-to-many)", "in-memory adapter", N, () =>
      runtime.getRelationship("airforce.Aircraft", "AC-0", "components", identity)
    ),
    await timeIt("query + filter (200 rows)", "in-memory adapter", N, () =>
      runtime.query({ type: "airforce.Aircraft", filter: { property: "maintenanceStatus", operator: "eq", value: "operational" } }, identity)
    )
  ];
}

async function benchmarkPostgres(): Promise<Sample[] | undefined> {
  const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
  if (!hasDb) {
    console.log("\n(skipping Postgres benchmark — set DATABASE_URL or PGHOST to include it)");
    return undefined;
  }

  const { createPool, runMigrations, PostgresRepositoryAdapter } = await import("@typesys/adapter-postgres");

  const pool = createPool();
  await runMigrations(pool);
  await pool.query("TRUNCATE objects");
  const adapter = new PostgresRepositoryAdapter(pool, "bench-pg", "bench-database");

  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const widgetSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/bench/Widget/1.0.0",
    title: "Widget",
    type: "object",
    properties: { id: { type: "string" }, status: { type: "string" } },
    "x-relationships": {
      parts: {
        target: "bench.Part",
        cardinality: "one-to-many",
        resolution: { dataSourceId: "bench-pg", operation: "byForeignKey:widgetId" }
      }
    },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(widgetSchema, { name: "bench.Widget", version: "1.0.0" });
  const partSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/bench/Part/1.0.0",
    title: "Part",
    type: "object",
    properties: { id: { type: "string" }, widgetId: { type: "string" } },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(partSchema, { name: "bench.Part", version: "1.0.0" });
  for (const typeName of ["bench.Widget", "bench.Part"]) {
    await registry.registerMapping({
      id: `map-${typeName}`,
      typeName,
      target: "property",
      targetName: "*",
      dataSourceId: "bench-pg",
      operation: "get",
      resolutionMode: "live"
    });
  }
  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  const runtime = new SemanticRuntime(registry, [adapter], policyEngine);

  for (let i = 0; i < 200; i++) {
    await adapter.put("bench.Widget", `W-${i}`, { id: `W-${i}`, status: i % 3 === 0 ? "retired" : "active" });
  }
  for (let i = 0; i < 400; i++) {
    await adapter.put("bench.Part", `P-${i}`, { id: `P-${i}`, widgetId: `W-${i % 200}` });
  }

  const samples = [
    await timeIt("getObject", "Postgres adapter", N, () => runtime.getObject("bench.Widget", "W-0", identity)),
    await timeIt("getRelationship (byForeignKey, indexed)", "Postgres adapter", N, () =>
      runtime.getRelationship("bench.Widget", "W-0", "parts", identity)
    ),
    await timeIt("query + filter (200 rows)", "Postgres adapter", N, () =>
      runtime.query({ type: "bench.Widget", filter: { property: "status", operator: "eq", value: "active" } }, identity)
    )
  ];

  await pool.end();
  return samples;
}

async function main(): Promise<void> {
  console.log(`Running each operation ${N} times (after 5 untimed warm-up calls)...\n`);

  const inMemorySamples = await benchmarkInMemory();
  console.log("\n=== In-memory adapter (isolates runtime overhead) ===");
  report(inMemorySamples);

  const pgSamples = await benchmarkPostgres();
  if (pgSamples) {
    console.log("\n=== PostgreSQL adapter (includes a real DB round trip) ===");
    report(pgSamples);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
