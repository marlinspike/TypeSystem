import { describe, it, expect } from "vitest";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRegistry } from "../src/registry/registry.js";
import { buildRuntime } from "../src/registry/build-runtime.js";
import { coreManifest } from "../src/base/manifest.js";
import type { AuditEvent } from "../src/audit/audit-log.js";

/** ADR-0101: every audit row names the deployment build that wrote it. */

const row = (id: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  id,
  timestamp: new Date(2026, 10, 2, 0, 0, Number(id.length)).toISOString(),
  subjectId: "s",
  action: "read",
  resource: { typeName: "t.T" },
  decision: "allow",
  ...extra
});

describe("audit rows name their build (ADR-0101)", () => {
  it("a registry given a build stamps every row it writes, and keeps a row's own", async () => {
    const store = new InMemoryRegistryStore();
    const registry = new SemanticRegistry(store, undefined, { build: "sha256:new" });
    expect(registry.build).toBe("sha256:new");
    await registry.appendAuditEvent(row("a"));
    await registry.appendAuditEvent(row("bb", { build: "sha256:old" }));
    const { items } = await store.listAuditEvents({ limit: 10 });
    expect(Object.fromEntries(items.map((e) => [e.id, e.build]))).toEqual({ a: "sha256:new", bb: "sha256:old" });
  });

  it("a registry built without one writes rows without one, as before", async () => {
    const store = new InMemoryRegistryStore();
    await new SemanticRegistry(store).appendAuditEvent(row("a"));
    expect((await store.listAuditEvents()).items[0]).not.toHaveProperty("build");
  });

  it("buildRuntime passes its build to the registry, so the runtime's decisions carry it", async () => {
    const { registry, runtime } = await buildRuntime({ manifests: [coreManifest], adapters: [], build: "sha256:abc" });
    await runtime.query({ type: "core.Asset", limit: 1 }, { subjectId: "nobody", roles: [], attributes: {} }).catch(() => undefined);
    const { items } = await registry.listAuditEvents({ limit: 5 });
    expect(items.length).toBeGreaterThan(0);
    for (const e of items) expect(e.build).toBe("sha256:abc");
  });
});
