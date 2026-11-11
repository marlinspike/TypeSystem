import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { corePack } from "@typesys/packs";
import { airforcePack } from "@typesys/domain-airforce";
import { airforceDeployment, airforceExtension } from "@typesys/demo-web/deployments";
import { auditCommand } from "../src/audit-cli.js";
import { buildHost, emptyEnvironment, overlayEnvironment } from "../src/host.js";
import { migrateDeployment } from "../src/migrate.js";
import { warnIfOwner } from "../src/state.js";
import type { Deployment } from "../src/deployment.js";

/**
 * ADR-0124: the server signs in as a role that may read and append its state,
 * never own it, so a stolen server credential cannot lift the append-only
 * triggers; and a witness kept outside the database catches the one thing a
 * database owner could still do unseen, deleting a chain whole with its
 * checkpoints. Needs DATABASE_URL as a role that may create roles.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

describe.skipIf(!DATABASE_URL)("a server role that does not own its state, and a witness (ADR-0124)", () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const schema = `audit_owner_${tag}`;
  const role = `typesys_rt_${tag}`;
  const at = (user?: { name: string; password: string }) => {
    const u = new URL(DATABASE_URL ?? "postgresql://localhost/x");
    if (user) {
      u.username = user.name;
      u.password = user.password;
    }
    u.searchParams.set("options", `-c search_path=${schema}`);
    return u.href;
  };
  const ownerUrl = at();
  const runtimeUrl = at({ name: role, password: "rt-pass'word" });
  let admin: pg.Pool;
  let dir: string;
  let file: string;
  let witness: string;
  const env = () => overlayEnvironment({ STATE_URL: runtimeUrl, STATE_OWNER_URL: ownerUrl, AUDIT_KEY: PRIVATE }, emptyEnvironment);
  const deployment: Deployment = {
    ...airforceDeployment,
    state: {
      audit: { kind: "postgres", url: { $secret: "STATE_URL" }, ownerUrl: { $secret: "STATE_OWNER_URL" }, signing: { keyId: "audit-1", key: { $secret: "AUDIT_KEY" }, everyRows: 4 }, verifyKeys: { "audit-1": PUBLIC }, retainDays: 30 },
      workflows: { kind: "postgres", url: { $secret: "STATE_URL" }, ownerUrl: { $secret: "STATE_OWNER_URL" } }
    }
  };

  async function run(...argv: string[]): Promise<{ code: number; out: string }> {
    let out = "";
    const write = (s: string | Uint8Array) => {
      out += String(s);
      return true;
    };
    const spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(write),
      vi.spyOn(process.stderr, "write").mockImplementation(write),
      vi.spyOn(console, "log").mockImplementation((s: unknown) => void (out += `${String(s)}\n`)),
      vi.spyOn(console, "error").mockImplementation((s: unknown) => void (out += `${String(s)}\n`))
    ];
    try {
      return { code: await auditCommand(argv, env()), out };
    } finally {
      spies.forEach((m) => m.mockRestore());
    }
  }

  async function serve(): Promise<void> {
    const host = await buildHost(deployment, { packs: [corePack, airforcePack], extensions: [airforceExtension], env: env() });
    for (const token of ["demo-maintainer-token", "demo-viewer-token"]) await host.runtime.getObject("airforce.Aircraft", "AF86-0147", await host.identityResolver(token));
    await host.close();
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    dir = await mkdtemp(path.join(os.tmpdir(), "typesys-owner-"));
    file = path.join(dir, "airforce.deployment.json");
    witness = path.join(dir, "witness.json");
    await writeFile(file, JSON.stringify({ ...deployment, packs: airforceDeployment.packs.map((p) => ({ ...p, file: path.join(repo, "packs", `${p.name}-${p.version}.typesys-pack.json`) })) }));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("migrates as the owner, creates the server's role and grants it read and append only", async () => {
    const done = await migrateDeployment(deployment, env());
    expect(done.map((d) => [d.store, d.runtimeRole])).toEqual([
      ["state.audit", role],
      ["state.workflows", role]
    ]);
    // Again, with the role in place: nothing new, the same grants.
    expect((await migrateDeployment(deployment, env())).every((d) => d.runtimeRole === role)).toBe(true);
  });

  it("serves over the server's role, which cannot delete, truncate or lift a trigger", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await serve();
      expect(warn.mock.calls.flat().join("\n")).not.toContain("owns these tables");
      // A server whose role owns the tables is warned about at start (a demo excepted).
      for (const [url, warned] of [[ownerUrl, true], [runtimeUrl, false]] as const) {
        warn.mockClear();
        const p = new pg.Pool({ connectionString: url, max: 1 });
        await warnIfOwner(p, ["audit_events", "audit_checkpoints"], "state.audit", false);
        await warnIfOwner(p, ["audit_events", "audit_checkpoints"], "state.audit", true);
        await p.end();
        expect(warn.mock.calls.length, url).toBe(warned ? 1 : 0);
        if (warned) expect(String(warn.mock.calls[0]![0])).toContain("state.audit: the server signs in as a role that owns these tables");
      }
    } finally {
      warn.mockRestore();
    }
    const rt = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      expect(Number((await rt.query<{ n: string }>("SELECT count(*) AS n FROM audit_events")).rows[0]!.n)).toBeGreaterThan(0);
      for (const sql of [
        "ALTER TABLE audit_events DISABLE TRIGGER ALL",
        "ALTER TABLE audit_checkpoints DISABLE TRIGGER USER",
        "DELETE FROM audit_checkpoints",
        "TRUNCATE audit_events",
        "UPDATE audit_events SET reason = 'x'",
        "BEGIN; SET LOCAL typesys.audit_prune = 'on'; DELETE FROM audit_events; COMMIT",
        "SET session_replication_role = replica",
        "DROP TABLE audit_checkpoints"
      ]) {
        await expect(rt.query(sql), sql).rejects.toThrow(/permission denied|must be owner|must be superuser/);
        await rt.query("ROLLBACK").catch(() => undefined);
      }
    } finally {
      await rt.end();
    }
  });

  it("refuses a deployment whose server and owner are one role", async () => {
    const same = overlayEnvironment({ STATE_URL: ownerUrl, STATE_OWNER_URL: ownerUrl, AUDIT_KEY: PRIVATE }, emptyEnvironment);
    await expect(migrateDeployment(deployment, same)).rejects.toThrow(/sign in as the same role/);
  });

  it("starts a witness, then catches a chain the database's owner deleted whole", async () => {
    const first = await run("verify", "--witness", witness, file);
    expect(first.code, first.out).toBe(0);
    const seen = JSON.parse(await readFile(witness, "utf8")) as { format: string; chains: Record<string, { checkpoint?: { seq: number }; head?: { seq: number } }> };
    expect(seen.format).toBe("typesys.audit-witness/1");
    const [chain, entry] = Object.entries(seen.chains)[0]!;
    expect(entry.head?.seq).toBeGreaterThan(0);
    expect(entry.checkpoint).toBeDefined();

    // More traffic: a second chain, and the witness moves forward with it.
    await serve();
    expect((await run("verify", "--witness", witness, file)).code).toBe(0);
    expect(Object.keys((JSON.parse(await readFile(witness, "utf8")) as typeof seen).chains)).toHaveLength(2);

    // The owner lifts the triggers and deletes a whole chain, checkpoints and all.
    await admin.query(`SET search_path = ${schema}`);
    await admin.query("ALTER TABLE audit_events DISABLE TRIGGER USER; ALTER TABLE audit_checkpoints DISABLE TRIGGER USER");
    await admin.query("DELETE FROM audit_events WHERE chain = $1", [chain]);
    await admin.query("DELETE FROM audit_checkpoints WHERE chain = $1", [chain]);
    await admin.query("ALTER TABLE audit_events ENABLE TRIGGER USER; ALTER TABLE audit_checkpoints ENABLE TRIGGER USER; RESET search_path");

    // Without the witness the trail is self-consistent: what is left verifies.
    expect((await run("verify", file)).code).toBe(0);
    const caught = await run("verify", "--witness", witness, file);
    expect(caught.code).toBe(1);
    expect(caught.out).toContain(`[vanished] chain ${chain}`);
    // A failed verification leaves the witness as it was, so the next one still catches it.
    expect((await run("verify", "--witness", witness, file)).code).toBe(1);
  });

  it("refuses a witness file that is not one", async () => {
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ format: "something-else" }));
    const r = await run("verify", "--witness", bad, file);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not a typesys\.audit-witness\/1 witness/);
  });
});
