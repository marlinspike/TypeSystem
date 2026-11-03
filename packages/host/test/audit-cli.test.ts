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
import { PostgresAuditLog, runMigrations } from "@typesys/registry-store-postgres";
import { auditCommand } from "../src/audit-cli.js";
import { buildHost, emptyEnvironment, overlayEnvironment } from "../src/host.js";
import type { Deployment } from "../src/deployment.js";

/**
 * ADR-0105: `typesys audit verify|export|prune` over a deployment that keeps
 * its trail in Postgres. The airforce demonstration, given durable signed
 * audit, serves reads; the trail verifies, an export verifies offline, an
 * edit is caught, and a prune leaves a trail that still verifies.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

describe.skipIf(!DATABASE_URL)("typesys audit (ADR-0105)", () => {
  const schema = `audit_cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let url: string;
  let dir: string;
  let file: string;
  let admin: pg.Pool;
  const env = () => overlayEnvironment({ DATABASE_URL: url, AUDIT_KEY: PRIVATE }, emptyEnvironment);
  const deployment = (retainDays?: number): Deployment => ({
    ...airforceDeployment,
    state: { audit: { kind: "postgres", url: { $secret: "DATABASE_URL" }, signing: { keyId: "audit-1", key: { $secret: "AUDIT_KEY" }, everyRows: 4 }, verifyKeys: { "audit-1": PUBLIC }, ...(retainDays ? { retainDays } : {}) } }
  });

  /** Runs the command and returns its exit code and everything it printed. */
  async function run(...argv: string[]): Promise<{ code: number; out: string }> {
    let out = "";
    const write = (s: string | Uint8Array) => {
      out += String(s);
      return true;
    };
    const a = vi.spyOn(process.stdout, "write").mockImplementation(write);
    const b = vi.spyOn(process.stderr, "write").mockImplementation(write);
    const c = vi.spyOn(console, "log").mockImplementation((s: unknown) => void (out += `${String(s)}\n`));
    const d = vi.spyOn(console, "error").mockImplementation((s: unknown) => void (out += `${String(s)}\n`));
    try {
      return { code: await auditCommand(argv, env()), out };
    } finally {
      [a, b, c, d].forEach((m) => m.mockRestore());
    }
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const u = new URL(DATABASE_URL!);
    u.searchParams.set("options", `-c search_path=${schema}`);
    url = u.href;
    const p = new pg.Pool({ connectionString: url, max: 1 });
    await runMigrations(p);
    await p.end();
    dir = await mkdtemp(path.join(os.tmpdir(), "typesys-audit-"));
    file = path.join(dir, "airforce.deployment.json");
    await writeFile(file, JSON.stringify({ ...deployment(30), packs: airforceDeployment.packs.map((p) => ({ ...p, file: path.join(repo, "packs", `${p.name}-${p.version}.typesys-pack.json`) })) }));
    // The deployment serves: reads as the maintainer and the viewer, each audited on the host's chain.
    const host = await buildHost(deployment(), { packs: [corePack, airforcePack], extensions: [airforceExtension], env: env() });
    for (const token of ["demo-maintainer-token", "demo-viewer-token", "demo-maintainer-token"]) await host.runtime.getObject("airforce.Aircraft", "AF86-0147", await host.identityResolver(token));
    await host.close();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("verifies the trail a serving deployment wrote", async () => {
    const r = await run("verify", file);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/OK: \d+ rows in 1 chain verify/);
    expect(r.out).toContain("signed through");
  });

  it("exports the trail, and the export verifies offline", async () => {
    const out = path.join(dir, "trail.jsonl");
    expect((await run("export", file, "--out", out)).code).toBe(0);
    const first = JSON.parse((await readFile(out, "utf8")).split("\n")[0]!) as { format: string };
    expect(first.format).toBe("typesys.audit-export/1");
    expect((await run("verify", "--file", out, file)).code).toBe(0);
    // An export edited after the fact fails.
    const text = await readFile(out, "utf8");
    await writeFile(out, text.replace('"decision":"allow"', '"decision":"deny"'));
    const edited = await run("verify", "--file", out, file, "--json");
    expect(edited.code).toBe(1);
    expect((JSON.parse(edited.out) as { problems: { kind: string }[] }).problems.map((p) => p.kind)).toContain("altered");
  });

  it("prunes behind a checkpoint, audits the prune, and the trail still verifies", async () => {
    const before = (await new PostgresAuditLog(new pg.Pool({ connectionString: url, max: 1 }), { ownsPool: true }).listAuditEvents({ limit: 1000 })).items.length;
    // Everything is older than the cutoff: the prune keeps the last checkpointed row, which anchors what remains.
    const r = await run("prune", file, "--before", new Date(Date.now() + 60_000).toISOString(), "--json");
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out) as { deleted: number };
    expect(result.deleted).toBeGreaterThan(0);
    expect(result.deleted).toBe(before - 1);
    const v = await run("verify", file);
    expect(v.code).toBe(0);
    const reader = new PostgresAuditLog(new pg.Pool({ connectionString: url, max: 1 }), { ownsPool: true });
    // Recorded before it deleted anything, and again with what it deleted.
    expect((await reader.listAuditEvents({ action: "audit.prune" })).items.map((e) => (e.details as { phase: string }).phase)).toEqual(["done", "started"]);
    await reader.close();
  });

  it("catches a row edited in the database", async () => {
    const p = new pg.Pool({ connectionString: url, max: 1 });
    await p.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update");
    await p.query("UPDATE audit_events SET subject_id = 'someone-else' WHERE id = (SELECT id FROM audit_events WHERE chain IS NOT NULL ORDER BY seq DESC LIMIT 1)");
    await p.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update");
    await p.end();
    const r = await run("verify", file);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[altered]");
  });

  it("refuses a deployment whose trail is not kept, and a prune with no retention", async () => {
    const memory = path.join(dir, "memory.deployment.json");
    await writeFile(memory, JSON.stringify({ ...airforceDeployment, packs: airforceDeployment.packs.map((p) => ({ ...p, file: path.join(repo, "packs", `${p.name}-${p.version}.typesys-pack.json`) })) }));
    expect((await run("verify", memory)).out).toContain("state.audit is not postgres");
    const forever = path.join(dir, "forever.deployment.json");
    await writeFile(forever, JSON.stringify({ ...deployment(), packs: airforceDeployment.packs.map((p) => ({ ...p, file: path.join(repo, "packs", `${p.name}-${p.version}.typesys-pack.json`) })) }));
    const r = await run("prune", forever);
    expect(r.code).toBe(1);
    expect(r.out).toContain("keeps its audit trail forever");
  });
});

describe("typesys audit keygen (ADR-0105)", () => {
  it("makes an Ed25519 key a deployment can name, and refuses a bad key id", async () => {
    let out = "";
    const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => void (out += `${String(s)}\n`));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await auditCommand(["keygen", "--key-id", "audit-2026"])).toBe(0);
      const doc = JSON.parse(out) as { signing: { keyId: string }; verifyKeys: Record<string, string> };
      expect(doc.signing.keyId).toBe("audit-2026");
      expect(doc.verifyKeys["audit-2026"]).toContain("PUBLIC KEY");
      expect(await auditCommand(["keygen", "--key-id", "../x"])).toBe(2);
    } finally {
      [log, err, errLog].forEach((m) => m.mockRestore());
    }
  });
});
