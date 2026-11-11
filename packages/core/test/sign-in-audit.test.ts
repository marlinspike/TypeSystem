import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SIGN_IN_FAILURES_PER_MINUTE, SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine } from "../src/policy/abac-policy-engine.js";

/**
 * ADR-0124: a refused token is an audit row under `unauthenticated`, with
 * what it claimed kept as a claim, and a flood of them is capped per minute
 * with the next row saying how many were left out.
 */
describe("failed sign-ins in the audit trail (ADR-0124)", () => {
  afterEach(() => vi.useRealTimers());

  it("writes each, caps them per minute, and says how many were not written", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-11T12:00:05Z"), toFake: ["Date"] });
    const store = new InMemoryRegistryStore();
    const runtime = new SemanticRuntime(new SemanticRegistry(store), [], new AbacPolicyEngine());
    for (let i = 0; i < SIGN_IN_FAILURES_PER_MINUTE + 3; i++) await runtime.recordSignInFailure({ transport: "api", reason: '"exp" claim timestamp check failed', claimed: { sub: `s${i}`, iss: "x".repeat(300) } });
    let rows = (await store.listAuditEvents({ limit: 1000 })).items;
    expect(rows).toHaveLength(SIGN_IN_FAILURES_PER_MINUTE);
    const first = rows.find((r) => (r.details as { claimed: { sub: string } }).claimed.sub === "s0")!;
    expect(first).toMatchObject({ subjectId: "unauthenticated", action: "sign-in", operation: "signIn", decision: "deny", resource: { typeName: "identity" }, reason: '"exp" claim timestamp check failed' });
    expect((first.details as { claimed: { iss: string } }).claimed.iss).toHaveLength(201);

    vi.setSystemTime(new Date("2026-11-11T12:01:00Z"));
    await runtime.recordSignInFailure({ transport: "mcp", reason: "signature verification failed" });
    rows = (await store.listAuditEvents({ limit: 1000 })).items;
    expect(rows).toHaveLength(SIGN_IN_FAILURES_PER_MINUTE + 1);
    expect(rows.find((r) => (r.details as { transport: string }).transport === "mcp")!.details).toEqual({ transport: "mcp", notRecorded: 3 });
  });
});
