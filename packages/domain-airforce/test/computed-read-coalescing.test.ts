import { describe, it, expect } from "vitest";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { MockRestAdapter, MockRestClient } from "@typesys/adapter-mock-rest";
import { DEMO_LINEAR_CLASSIFICATION, buildRuntime, coreManifest, type Adapter, type Identity, type SemanticQuery, type SemanticRuntime } from "@typesys/core";
import { AIRCRAFT_DATA_SOURCE_ID, MAINTENANCE_DATA_SOURCE_ID, airforceManifest, airforcePolicyRules, demoIdentities } from "../src/index.js";

/** A fleet in which every combination of status, maintenance history and open work matters to `needsAttention`. */
function fleet(seed: number, size: number) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const statuses = ["operational", "operational", "operational", "degraded", "down"];
  const aircraft = Array.from({ length: size }, (_, i) => ({
    objectId: `T-${i}`,
    values: { id: `T-${i}`, name: `Tail ${i}`, tailNumber: `T-${i}`, model: i % 2 ? "F-16C" : "C-17A", maintenanceStatus: statuses[Math.floor(rand() * statuses.length)], deploymentLocation: `Site ${i % 4}` }
  }));
  const events = aircraft.flatMap((a, i) =>
    Array.from({ length: Math.floor(rand() * 3) }, (_, j) => ({ event_id: `EV-${i}-${j}`, aircraft_tail: a.objectId, event_type: "inspection", event_date: "2026-10-01", notes: "" }))
  );
  const workOrders = events.filter(() => rand() < 0.6).map((e, k) => ({ wo_id: `WO-${k}`, event_id: e.event_id, status: rand() < 0.5 ? "closed" : "open", assigned_to: "SSgt Rivera", created_at: "2026-10-02T00:00:00Z" }));
  return { aircraft, events, workOrders };
}

/** Counts the calls that reach an adapter, below everything the runtime does. */
function counted(adapter: Adapter) {
  const calls: string[] = [];
  const proxy = new Proxy(adapter, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || prop === "canFilter" || prop === "sensitiveFields") return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
  });
  return { adapter: proxy, calls };
}

async function runtimeOver(data: ReturnType<typeof fleet>, computedReads: "direct" | "coalesce") {
  const repo = new InMemoryRepositoryAdapter(AIRCRAFT_DATA_SOURCE_ID, "airforce-repo");
  repo.seed("airforce.Aircraft", data.aircraft);
  const client = new MockRestClient(0);
  client.seedMaintenanceEvents(data.events);
  client.seedWorkOrders(data.workOrders);
  const maintenance = counted(new MockRestAdapter(MAINTENANCE_DATA_SOURCE_ID, client, { maintenanceEventType: "airforce.MaintenanceEvent", workOrderType: "airforce.WorkOrder" }));
  const { runtime } = await buildRuntime({
    manifests: [coreManifest, airforceManifest],
    adapters: [repo, maintenance.adapter],
    policyRules: airforcePolicyRules,
    runtimeOptions: { classification: DEMO_LINEAR_CLASSIFICATION, computedReads, maxConcurrency: 8 }
  });
  return { runtime, calls: maintenance.calls };
}

async function outcome(runtime: SemanticRuntime, q: SemanticQuery, who: Identity): Promise<unknown> {
  const pages: unknown[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await runtime.query(cursor ? { ...q, cursor } : q, who);
      pages.push(page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return JSON.parse(JSON.stringify(pages, (k, v: unknown) => (k === "retrievedAt" ? "<t>" : v))) as unknown;
  } catch (err) {
    return { refused: (err as Error).message };
  }
}

const QUERIES: SemanticQuery[] = [
  { type: "airforce.Aircraft", limit: 25 },
  { type: "airforce.Aircraft", filter: { property: "needsAttention", operator: "eq", value: true }, limit: 10 },
  { type: "airforce.Aircraft", filter: { and: [{ property: "model", operator: "eq", value: "F-16C" }, { property: "needsAttention", operator: "eq", value: false }] }, limit: 7 },
  { type: "airforce.Aircraft", filter: { property: "readinessStatus", operator: "in", value: ["NMC", "PMC"] }, select: ["tailNumber", "readinessStatus", "needsAttention"], limit: 50 },
  { type: "airforce.Aircraft", include: [{ relationship: "maintenance", include: [{ relationship: "workOrder" }] }], limit: 15 }
];

describe("coalesced computed reads give the same answers with fewer adapter calls (ADR-0062)", () => {
  it("answers every query, for every caller, exactly as direct reads do", async () => {
    for (const seed of [1, 7, 42]) {
      const data = fleet(seed, 60);
      const direct = await runtimeOver(data, "direct");
      const coalesced = await runtimeOver(data, "coalesce");
      for (const q of QUERIES)
        for (const who of [demoIdentities.maintainer, demoIdentities.viewer, demoIdentities.anonymous]) {
          expect(await outcome(coalesced.runtime, q, who), `seed ${seed}, ${who.subjectId}, ${JSON.stringify(q)}`).toEqual(await outcome(direct.runtime, q, who));
        }
      expect(coalesced.calls.length).toBeLessThan(direct.calls.length);
    }
  });

  it("reads the maintenance system a few times per page instead of once or twice per aircraft", async () => {
    const data = fleet(3, 200);
    const page = { type: "airforce.Aircraft", select: ["tailNumber", "needsAttention"], limit: 200 } satisfies SemanticQuery;
    const direct = await runtimeOver(data, "direct");
    const coalesced = await runtimeOver(data, "coalesce");
    await direct.runtime.query(page, demoIdentities.maintainer);
    await coalesced.runtime.query(page, demoIdentities.maintainer);
    const operational = data.aircraft.filter((a) => a.values.maintenanceStatus === "operational").length;
    // Directly: one lookup of events per operational aircraft, and every work order again for each that has events.
    expect(direct.calls.length).toBeGreaterThanOrEqual(operational);
    // Coalesced: the event lookups of each burst of concurrent computations (at most maxConcurrency, 8 here) share one
    // query, and the work orders are read once.
    expect(coalesced.calls.length).toBeLessThan(direct.calls.length / 8);
    expect(coalesced.calls.filter((c) => c === "queryByType").length).toBe(coalesced.calls.length);
  });

  it("is refused as an unknown setting, not ignored", async () => {
    await expect(runtimeOver(fleet(1, 1), "sometimes" as "direct")).rejects.toThrow('computedReads must be "direct" or "coalesce"');
  });
});
