import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationError, SourceRefusedError, type Identity, type ResolvedObject } from "@typesys/core";
import { createApiApp } from "@typesys/http";
import { buildSortieHost, resolveSortieIdentity, sortieIdentities, startService, startServices, type RunningService, type RunningServices, type SortieHost } from "../src/index.js";

/**
 * Sortie readiness across three independently written services (ADR-0072):
 * a fleet registry, a parts depot and a crew roster, each its own process
 * with its own data model and its own authorization. One governed query
 * reads all three; latency, a failed service, a schema upgrade and both
 * layers of access control are each a scenario.
 */
const { planner, maintainer, viewer } = sortieIdentities;
const TAIL = "AF86-0147";
const withIncludes = { type: "ops.Aircraft", filter: { property: "tailNumber", operator: "eq" as const, value: TAIL }, include: [{ relationship: "crew" }, { relationship: "requisitions" }] };

async function one(host: SortieHost, who: Identity): Promise<ResolvedObject> {
  const { items } = await host.runtime.query({ ...withIncludes, includeProvenance: true }, who);
  expect(items).toHaveLength(1);
  return items[0]!;
}

let services: RunningServices;
let host: SortieHost;
const urls = () => ({ fleet: services.fleet.url, depot: services.depot.url, roster: services.roster.url });

beforeAll(async () => {
  services = await startServices();
  host = await buildSortieHost({ urls: urls() });
}, 30_000);
afterAll(() => services?.stop());

describe("one governed read across three services", () => {
  it("returns the aircraft, its crew and its requisitions, each value traced to the system it came from", async () => {
    const aircraft = await one(host, planner);
    expect(aircraft.values).toMatchObject({ tailNumber: TAIL, mds: "F-16C", missionCapability: "partial" });
    expect((aircraft.values.crew as ResolvedObject[]).map((c) => c.values.callsign).sort()).toEqual(["TALON", "VIPER"]);
    expect((aircraft.values.requisitions as ResolvedObject[]).map((r) => r.values.status).sort()).toEqual(["in-transit", "issued"]);
    expect(aircraft.unavailable).toBeUndefined();
    expect(aircraft.provenance?.find((p) => p.propertyPath === "missionCapability")?.source).toMatchObject({ system: "Fleet registry", field: "mc_status", recordId: TAIL });
    const crew = await host.runtime.getObject("ops.CrewMember", "C-1001", planner, { includeProvenance: true });
    expect(crew.provenance?.find((p) => p.propertyPath === "available")?.source).toMatchObject({ system: "Crew roster", field: "duty" });
  });

  it("each service is called only through its own contract: TypeSystem holds one credential per service, and the services share nothing", async () => {
    // The fleet registry's paging is followed: a list spans more than one of its pages.
    const { items } = await host.runtime.query({ type: "ops.Aircraft", filter: { property: "base", operator: "eq", value: "KHIF" } }, planner);
    expect(items.map((a) => a.objectId).sort()).toEqual(["AF09-4126", "AF86-0147", "AF87-0212", "AF88-0405"]);
  });
});

describe("access control is enforced by TypeSystem and by each service", () => {
  it("TypeSystem refuses what the services would give it: a viewer gets no requisitions, no crew and no mission capability", async () => {
    const aircraft = await one(host, viewer);
    expect(aircraft.values).not.toHaveProperty("missionCapability");
    await expect(host.runtime.getObject("ops.Requisition", "KHIF-6281-0001", viewer)).rejects.toThrow(AuthorizationError);
    await expect(host.runtime.getObject("ops.CrewMember", "C-1001", viewer)).rejects.toThrow(AuthorizationError);
  });

  it("a service refuses what TypeSystem would allow: the depot key is issued for KHIF only, so a planner cannot read a KVPS requisition", async () => {
    await expect(host.runtime.getObject("ops.Requisition", "KVPS-6280-0001", planner)).rejects.toThrow(SourceRefusedError);
    const hq = await buildSortieHost({ urls: urls(), depotKey: "depot-hq-key" });
    expect((await hq.runtime.getObject("ops.Requisition", "KVPS-6280-0001", planner)).values).toMatchObject({ base: "KVPS", status: "awaiting" });
    // A list is narrowed by the service, not refused: the hill key's list holds KHIF only.
    expect((await host.runtime.query({ type: "ops.Requisition" }, planner)).items.every((r) => r.values.base === "KHIF")).toBe(true);
  });

  it("a crew member's name needs both: the roster's roster.pii scope, and TypeSystem's planner-of-the-unit rule", async () => {
    // Without the scope the roster never sends the name, so nobody sees it.
    expect((await host.runtime.getObject("ops.CrewMember", "C-1001", planner)).values).not.toHaveProperty("name");
    const pii = await buildSortieHost({ urls: urls(), rosterPii: true });
    expect((await pii.runtime.getObject("ops.CrewMember", "C-1001", planner)).values).toMatchObject({ name: "Capt Dana Reyes" });
    // With it, TypeSystem still withholds the name from a maintainer, and from a planner of another unit.
    expect((await pii.runtime.getObject("ops.CrewMember", "C-1001", maintainer)).values).not.toHaveProperty("name");
    expect((await pii.runtime.getObject("ops.CrewMember", "C-2001", planner)).values).not.toHaveProperty("name");
  });
});

describe("a failed service", () => {
  it("leaves the rest of the answer, and says what is missing and why", async () => {
    const roster = await startService("crew-roster");
    const partial = await buildSortieHost({ urls: { ...urls(), roster: roster.url } });
    expect((await one(partial, planner)).values.crew).toHaveLength(2);
    await roster.stop();

    const aircraft = await one(partial, planner);
    expect(aircraft.values).toMatchObject({ tailNumber: TAIL, missionCapability: "partial" });
    expect(aircraft.values).not.toHaveProperty("crew");
    expect(aircraft.values.requisitions).toHaveLength(2);
    expect(aircraft.unavailable).toEqual([{ path: "crew", dataSourceId: "crew-roster", reason: "unavailable", message: expect.stringMatching(/Crew roster could not be reached/) as string }]);
  });

  it("a service's refusal of TypeSystem's own credential is reported as a refusal, not as an empty list", async () => {
    const refused = await buildSortieHost({ urls: urls(), depotKey: "revoked-key" });
    const aircraft = await one(refused, planner);
    expect(aircraft.values).not.toHaveProperty("requisitions");
    expect(aircraft.unavailable).toEqual([{ path: "requisitions", dataSourceId: "parts-depot", reason: "refused-by-source", message: expect.stringMatching(/401/) as string }]);
  });

  it("a read of the failed service itself is refused with what failed, not answered with nothing", async () => {
    const fleet = await startService("fleet-registry");
    const down = await buildSortieHost({ urls: { ...urls(), fleet: fleet.url } });
    await fleet.stop();
    await expect(down.runtime.getObject("ops.Aircraft", TAIL, planner)).rejects.toThrow(/Fleet registry could not be reached/);
  });
});

describe("latency", () => {
  let slow: RunningService[] = [];
  afterAll(async () => Promise.all(slow.map((s) => s.stop())));

  it("the crew and the requisitions are read concurrently, so two slow services cost one wait, not two", async () => {
    slow = await Promise.all([startService("crew-roster", { latencyMs: 400 }), startService("parts-depot", { latencyMs: 400 })]);
    const h = await buildSortieHost({ urls: { fleet: services.fleet.url, roster: slow[0]!.url, depot: slow[1]!.url } });
    await one(h, planner); // the roster's token, once
    const started = performance.now();
    const aircraft = await one(h, planner);
    const elapsed = performance.now() - started;
    expect(aircraft.values.crew).toHaveLength(2);
    expect(aircraft.values.requisitions).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(800 + 300);
  });

  it("a service slower than the deadline is reported as timed out, and the rest arrives on time", async () => {
    const glacial = await startService("crew-roster", { latencyMs: 1_500 });
    slow.push(glacial);
    const h = await buildSortieHost({ urls: { ...urls(), roster: glacial.url }, runtimeOptions: { resilience: { callTimeoutMs: 300 } } });
    const started = performance.now();
    const aircraft = await one(h, planner);
    expect(performance.now() - started).toBeLessThan(1_200);
    expect(aircraft.values.requisitions).toHaveLength(2);
    expect(aircraft.unavailable).toEqual([{ path: "crew", dataSourceId: "crew-roster", reason: "timeout", message: expect.any(String) as string }]);
  });
});

describe("schema evolution in one service", () => {
  it("the parts depot's v2 upgrade changes the adapter's mapping and nothing a consumer receives, byte for byte", async () => {
    const v2 = await startService("parts-depot", { schema: 2 });
    try {
      const before = await buildSortieHost({ urls: urls(), depotSchema: 1 });
      const after = await buildSortieHost({ urls: { ...urls(), depot: v2.url }, depotSchema: 2 });
      const body = async (h: SortieHost, path: string, init?: RequestInit) => {
        const server = await new Promise<Server>((resolve) => {
          const s = createApiApp({ backend: h, identityResolver: resolveSortieIdentity }).listen(0, "127.0.0.1", () => resolve(s));
        });
        try {
          const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${path}`, { ...init, headers: { authorization: "Bearer demo-planner-token", "content-type": "application/json" } });
          expect(res.status).toBe(200);
          return await res.text();
        } finally {
          await new Promise<void>((r) => server.close(() => r()));
        }
      };
      const query = { method: "POST", body: JSON.stringify({ ...withIncludes, include: [{ relationship: "requisitions", sort: [{ property: "nsn" }] }] }) };
      for (const [path, init] of [["/query", query], ["/objects/ops.Requisition/KHIF-6281-0001", undefined], ["/query", { method: "POST", body: JSON.stringify({ type: "ops.Requisition", filter: { property: "status", operator: "eq", value: "in-transit" } }) }]] as const) {
        const [b, a] = await Promise.all([body(before, path, init), body(after, path, init)]);
        expect(a).toBe(b);
      }
      // Provenance follows the upgrade truthfully: the same value, now from the depot's renamed field.
      const field = async (h: SortieHost) => (await h.runtime.getProvenance("ops.Requisition", "KHIF-6281-0001", "status", planner))[0]?.source.field;
      expect([await field(before), await field(after)]).toEqual(["status", "state"]);
    } finally {
      await v2.stop();
    }
  });
});
