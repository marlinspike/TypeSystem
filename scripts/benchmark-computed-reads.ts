/**
 * Computed reads, direct against coalesced (ADR-0062): `npx tsx scripts/benchmark-computed-reads.ts`.
 *
 * A page of 200 aircraft with a maintenance history (up to two events each,
 * about 60% with a work order), read as the maintainer with `needsAttention`,
 * which looks up each operational aircraft's events and every work order in
 * the maintenance system. Repeated at three simulated maintenance-system
 * latencies, counting the calls that reach that system.
 */
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { MockRestAdapter, MockRestClient } from "@typesys/adapter-mock-rest";
import { DEMO_LINEAR_CLASSIFICATION, buildRuntime, coreManifest, type Adapter, type SemanticQuery } from "@typesys/core";
import { AIRCRAFT_DATA_SOURCE_ID, MAINTENANCE_DATA_SOURCE_ID, airforceManifest, airforcePolicyRules, demoIdentities } from "@typesys/domain-airforce";

let s = 3;
const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const statuses = ["operational", "operational", "operational", "degraded", "down"];
const aircraft = Array.from({ length: 200 }, (_, i) => ({
  objectId: `T-${i}`,
  values: { id: `T-${i}`, name: `Tail ${i}`, tailNumber: `T-${i}`, model: "F-16C", maintenanceStatus: statuses[Math.floor(rand() * statuses.length)] }
}));
const events = aircraft.flatMap((a, i) =>
  Array.from({ length: Math.floor(rand() * 3) }, (_, j) => ({ event_id: `EV-${i}-${j}`, aircraft_tail: a.objectId, event_type: "inspection", event_date: "2026-10-01", notes: "" }))
);
const workOrders = events
  .filter(() => rand() < 0.6)
  .map((e, k) => ({ wo_id: `WO-${k}`, event_id: e.event_id, status: rand() < 0.5 ? "closed" : "open", assigned_to: "SSgt Rivera", created_at: "2026-10-02T00:00:00Z" }));
const page: SemanticQuery = { type: "airforce.Aircraft", select: ["tailNumber", "needsAttention"], limit: 200 };

const rows: Record<string, string>[] = [];
for (const latencyMs of [0, 2, 10]) {
  for (const computedReads of ["direct", "coalesce"] as const) {
    const repo = new InMemoryRepositoryAdapter(AIRCRAFT_DATA_SOURCE_ID, "airforce-repo");
    repo.seed("airforce.Aircraft", aircraft);
    const client = new MockRestClient(latencyMs);
    client.seedMaintenanceEvents(events);
    client.seedWorkOrders(workOrders);
    const inner = new MockRestAdapter(MAINTENANCE_DATA_SOURCE_ID, client, { maintenanceEventType: "airforce.MaintenanceEvent", workOrderType: "airforce.WorkOrder" });
    let calls = 0;
    const maintenance = new Proxy(inner, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop !== "queryByType" && prop !== "resolveProperties") return value;
        return (...args: unknown[]) => {
          calls++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
    }) as Adapter;
    const { runtime } = await buildRuntime({
      manifests: [coreManifest, airforceManifest],
      adapters: [repo, maintenance],
      policyRules: airforcePolicyRules,
      runtimeOptions: { classification: DEMO_LINEAR_CLASSIFICATION, computedReads }
    });
    const runs = latencyMs === 0 ? 100 : 20;
    for (let i = 0; i < 5; i++) await runtime.query(page, demoIdentities.maintainer);
    calls = 0;
    const ms: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await runtime.query(page, demoIdentities.maintainer);
      ms.push(performance.now() - start);
    }
    ms.sort((a, b) => a - b);
    rows.push({
      "latency per call": `${latencyMs} ms`,
      computedReads,
      "calls per page": (calls / runs).toFixed(0),
      p50: ms[Math.floor(runs / 2)]!.toFixed(1),
      p95: ms[Math.floor(runs * 0.95)]!.toFixed(1)
    });
  }
}
console.table(rows);
