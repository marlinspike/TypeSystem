import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import pg from "pg";
import { airforceDeployment } from "@typesys/demo-web/deployments";
import type { Deployment } from "../src/deployment.js";
import { emptyEnvironment, type HostEnvironment } from "../src/host.js";
import { migrateCommand, migrateDeployment, stateProblems } from "../src/migrate.js";

const DATABASE_URL = process.env.DATABASE_URL;

const envOf = (vars: Record<string, string>): HostEnvironment => ({ env: (n) => vars[n], secret: (n) => vars[n] });

describe("typesys migrate without Postgres state (ADR-0117)", () => {
  it("has nothing to do for a deployment that keeps its state in the process", async () => {
    expect(await migrateDeployment(airforceDeployment, emptyEnvironment)).toEqual([]);
    expect(await stateProblems(airforceDeployment, emptyEnvironment)).toEqual([]);
  });

  it("names a missing secret, and never repeats a connection string it was given", async () => {
    const d = { ...airforceDeployment, state: { audit: { kind: "postgres", url: { $secret: "STATE_URL" } } } } as unknown as Deployment;
    await expect(migrateDeployment(d, emptyEnvironment)).rejects.toThrow("state.audit.url: secret STATE_URL is not set");
    const problems = await stateProblems(d, envOf({ STATE_URL: "postgres://someone:hunter2@127.0.0.1:1/nowhere" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^state\.audit: cannot read the database/);
    expect(problems[0]).not.toContain("hunter2");
  });

  it("reads its deployment from TYPESYS_DEPLOYMENT and refuses unknown options", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "typesys-migrate-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const file = path.join(dir, "d.json");
      writeFileSync(file, JSON.stringify(airforceDeployment));
      expect(await migrateCommand([], envOf({ TYPESYS_DEPLOYMENT: file }))).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toContain("keeps no state in Postgres: nothing to migrate");
      expect(await migrateCommand([file, "--force"], emptyEnvironment)).toBe(2);
      expect(await migrateCommand([], emptyEnvironment)).toBe(2);
    } finally {
      log.mockRestore();
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!DATABASE_URL)("typesys migrate against Postgres (ADR-0117)", () => {
  const schema = `migrate_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url = (() => {
    const u = new URL(DATABASE_URL ?? "postgresql://localhost/x");
    u.searchParams.set("options", `-c search_path=${schema}`);
    return u.href;
  })();
  let admin: pg.Pool;
  const d = {
    ...airforceDeployment,
    state: { audit: { kind: "postgres", url: { $secret: "STATE_URL" } }, workflows: { kind: "postgres", url: { $secret: "STATE_URL" } } }
  } as unknown as Deployment;
  const env = envOf({ STATE_URL: url });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("reports an unmigrated audit database, migrates every Postgres store, and is safe to run again, twice at once", async () => {
    const before = await stateProblems(d, env);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatch(/^state\.audit: \d+ migrations not applied \(0001_init\.sql, .*\): run `typesys migrate <deployment\.json>`$/);

    const [a, b] = await Promise.all([migrateDeployment(d, env), migrateDeployment(d, env)]);
    // The advisory lock serializes them: one applies everything, the other finds it applied.
    const audit = [a, b].map((r) => r.find((s) => s.store === "state.audit")!);
    expect(audit.map((r) => r.applied.length).sort()).toEqual([0, audit[0]!.applied.length + audit[1]!.applied.length]);
    expect([a, b].every((r) => r.some((s) => s.store === "state.workflows"))).toBe(true);

    expect(await stateProblems(d, env)).toEqual([]);
    const again = await migrateDeployment(d, env);
    expect(again.find((s) => s.store === "state.audit")!.applied).toEqual([]);

    const tables = (await admin.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [schema])).rows.map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(["audit_events", "audit_checkpoints", "typesys_workflow_runs"]));
    // The demo adapter's tables are never created in a deployment's state database.
    expect(tables).not.toContain("objects");
  });
});
