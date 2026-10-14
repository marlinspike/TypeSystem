import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationError } from "@typesys/core";
import { buildSortieHost, sortieIdentities, startServices, type RunningServices, type SortieHost } from "../src/index.js";

/**
 * Pressure test 3 (P3) of the governed contract over three independent
 * services (ADR-0072). Each test states what the ADRs promise and fails on
 * the reviewed head (identical to PR #14).
 */
const { planner, viewer, anonymous } = sortieIdentities;

let services: RunningServices;
let host: SortieHost;
const urls = () => ({ fleet: services.fleet.url, depot: services.depot.url, roster: services.roster.url });

beforeAll(async () => {
  services = await startServices();
  host = await buildSortieHost({ urls: urls() });
}, 30_000);
afterAll(() => services?.stop());

/** How a read ends: the error's class name, or "ok". */
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof Error ? e.constructor.name : String(e)));

describe("P3 interop: a caller TypeSystem refuses learns nothing from the service's refusal", () => {
  it("P3-I1: an anonymous caller (and a viewer) is refused the same way for a KVPS requisition that exists and one that does not", async () => {
    for (const who of [anonymous, viewer]) {
      const exists = await outcome(host.runtime.getObject("ops.Requisition", "KVPS-6280-0001", who));
      const missing = await outcome(host.runtime.getObject("ops.Requisition", "KVPS-6280-9999", who));
      const khif = await outcome(host.runtime.getObject("ops.Requisition", "KHIF-6281-0001", who));
      // ADR-0048: "the decision comes first, so a denied caller is told nothing about whether the id exists".
      // Today the existing KVPS row is a SourceRefusedError (HTTP 502 source-refused) and the others an
      // AuthorizationError (403): the depot's 403-for-another-base is an existence oracle for anyone.
      expect({ exists, missing, khif }).toEqual({ exists: AuthorizationError.name, missing: AuthorizationError.name, khif: AuthorizationError.name });
    }
  });
});

describe("P3 interop: a service's refusal is not an outage", () => {
  it("P3-I2: a planner's refused reads of another base do not open the depot's circuit for every caller's KHIF reads", async () => {
    const guarded = await buildSortieHost({ urls: urls(), runtimeOptions: { resilience: { callTimeoutMs: 2_000, circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 } } } });
    // ADR-0072 describes this refusal as expected: the hill key is issued for KHIF only.
    expect(await outcome(guarded.runtime.getObject("ops.Requisition", "KVPS-6280-0001", planner))).toBe("SourceRefusedError");
    expect(await outcome(guarded.runtime.getObject("ops.Requisition", "KVPS-6280-0001", planner))).toBe("SourceRefusedError");
    // The depot answered both times; it is not down. Today: CircuitOpenError, and an optional include of
    // requisitions is then reported as `unavailable` rather than read.
    expect(await outcome(guarded.runtime.getObject("ops.Requisition", "KHIF-6281-0001", planner))).toBe("ok");
    const { items } = await guarded.runtime.query({ type: "ops.Aircraft", filter: { property: "tailNumber", operator: "eq", value: "AF86-0147" }, include: [{ relationship: "requisitions" }] }, planner);
    expect(items[0]?.unavailable).toBeUndefined();
  });
});
