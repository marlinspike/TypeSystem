import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createClient } from "redis";
import { RateLimitExceededError, verifyAuditLog, type DomainManifest } from "@typesys/core";
import { buildPack, corePack } from "@typesys/packs";
import { PostgresAuditLog, runMigrations } from "@typesys/registry-store-postgres";
import { buildHost, overlayEnvironment, emptyEnvironment, type Host } from "../src/host.js";
import { DEPLOYMENT_FORMAT, DeploymentError, type Deployment } from "../src/deployment.js";

/**
 * ADR-0106 and ADR-0107 against a live Postgres and Redis: a deployment that
 * declares its state keeps its audit trail across restarts and replicas, one
 * chain per process that verifies, one rate budget across replicas, and
 * reads a declared Postgres table with no code. Skipped without them.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

const erp: DomainManifest = {
  domain: "erp",
  dataSources: [{ id: "erp-db", name: "Legacy ERP", kind: "postgres" }],
  types: [
    {
      schema: {
        $id: "https://typesys.dev/types/erp/Part/1.0.0",
        title: "Part",
        type: "object",
        properties: { partNumber: { type: "string" }, description: { type: "string" }, onHand: { type: "integer" }, unitCost: { type: "number" } },
        "x-policy": { objectPolicy: "erp.read", propertyPolicies: { unitCost: "erp.finance" } }
      },
      options: { name: "erp.Part", version: "1.0.0" }
    }
  ],
  mappings: [{ id: "map-part", typeName: "erp.Part", target: "property", targetName: "*", dataSourceId: "erp-db", operation: "get", resolutionMode: "live" }]
};
const erpPack = buildPack({ name: "erp", version: "1.0.0", description: "A legacy ERP's parts table", manifests: [erp] });

describe.skipIf(!DATABASE_URL)("a deployment that declares its state (ADR-0106, ADR-0107)", () => {
  const schema = `durable_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url = (() => {
    const u = new URL(DATABASE_URL ?? "postgresql://localhost/x");
    u.searchParams.set("options", `-c search_path=${schema}`);
    return u.href;
  })();
  let admin: pg.Pool;
  const hosts: Host[] = [];

  const deployment = (extra: Partial<Deployment> = {}): Deployment => ({
    format: DEPLOYMENT_FORMAT,
    name: "erp",
    packs: [
      { name: "core", version: corePack.version },
      { name: "erp", version: "1.0.0" }
    ],
    sources: {
      "erp-db": { kind: "postgres", system: "Legacy ERP", url: { $secret: "ERP_URL" }, types: { "erp.Part": { table: "parts", id: "part_no", columns: { partNumber: "part_no", description: "descr", onHand: { column: "qty", as: "integer" }, unitCost: { column: "cost", as: "number" } } } } }
    },
    state: {
      audit: { kind: "postgres", url: { $secret: "DATABASE_URL" }, signing: { keyId: "audit-1", key: { $secret: "AUDIT_KEY" }, everyRows: 5 }, verifyKeys: { "audit-1": PUBLIC } },
      workflows: { kind: "postgres", url: { $secret: "DATABASE_URL" } },
      ...(REDIS_URL ? { rateLimit: { kind: "redis" as const, url: { $secret: "REDIS_URL" }, capacity: 6, refillPerSecond: 0, keyPrefix: `${schema}:rl:` }, cache: { kind: "redis" as const, url: { $secret: "REDIS_URL" }, keyPrefix: `${schema}:c:` } } : {})
    },
    policies: { "erp.read": { role: ["planner", "buyer"] }, "erp.finance": { role: ["buyer"] } },
    identity: { kind: "oidc", issuer: "https://issuer.example", audience: "erp" },
    personas: {
      planner: { subjectId: "planner-1", roles: ["planner"], attributes: {} },
      buyer: { subjectId: "buyer-1", roles: ["buyer"], attributes: {} }
    },
    ...extra
  });
  const env = overlayEnvironment({ DATABASE_URL: url, ERP_URL: url, AUDIT_KEY: PRIVATE, REDIS_URL }, emptyEnvironment);
  const boot = async (d: Deployment = deployment()) => {
    const h = await buildHost(d, { packs: [corePack, erpPack], env });
    hosts.push(h);
    return h;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const p = new pg.Pool({ connectionString: url, max: 1 });
    await runMigrations(p);
    await p.query(`CREATE TABLE parts (part_no text PRIMARY KEY, descr text, qty integer, cost numeric(10,2));
      INSERT INTO parts VALUES ('P-100', 'Hydraulic pump', 4, 1250.00), ('P-200', 'Seal kit', 40, 12.50);`);
    await p.end();
  });

  afterAll(async () => {
    await Promise.allSettled(hosts.map((h) => h.close()));
    if (REDIS_URL) {
      const r = createClient({ url: REDIS_URL });
      await r.connect();
      for await (const keys of r.scanIterator({ MATCH: `${schema}:*` })) if (keys.length) await r.del(keys);
      await r.quit();
    }
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("reads a declared Postgres table, governed, with no code (ADR-0107)", async () => {
    const host = await boot();
    const planner = host.personas.planner!;
    const buyer = host.personas.buyer!;
    const part = await host.runtime.getObject("erp.Part", "P-100", buyer);
    expect(part.values).toMatchObject({ partNumber: "P-100", description: "Hydraulic pump", onHand: 4, unitCost: 1250 });
    expect((await host.runtime.getObject("erp.Part", "P-100", planner)).values).not.toHaveProperty("unitCost");
    expect(host.code.sources).toEqual({});
    await host.close();
  });

  it("is ready only while every declared store answers", async () => {
    const host = await boot();
    await expect(host.state.ready()).resolves.toBeUndefined();
    await host.close();
    // Closed, its pools are gone: a replica in that state must leave rotation.
    await expect(host.state.ready()).rejects.toThrow();
  });

  it("keeps the audit trail across a restart, one signed chain per process, and both verify", async () => {
    const first = await boot();
    for (let i = 0; i < 3; i++) await first.runtime.getObject("erp.Part", "P-200", first.personas.planner!);
    const firstChain = first.state.audit.chain;
    await first.close();
    const second = await boot();
    await second.runtime.getObject("erp.Part", "P-100", second.personas.buyer!);
    const secondChain = second.state.audit.chain;
    expect(secondChain).not.toBe(firstChain);
    await second.close();

    const reader = new PostgresAuditLog(new pg.Pool({ connectionString: url, max: 1 }), { ownsPool: true });
    try {
      const v = await verifyAuditLog(reader, { "audit-1": PUBLIC });
      expect(v.problems).toEqual([]);
      const chains = Object.fromEntries(v.chains.map((c) => [c.chain, c]));
      // Each closed host signed its last row as it stopped, so nothing it wrote is unanchored.
      expect(chains[firstChain]).toMatchObject({ unanchored: 0, builds: [first.build] });
      expect(chains[secondChain]).toMatchObject({ unanchored: 0 });
      const rows = await reader.readChain(firstChain);
      expect(rows.some((r) => r.event.subjectId === "planner-1" && r.event.resource.typeName === "erp.Part")).toBe(true);
    } finally {
      await reader.close();
    }
  });

  it("refuses to start against audit tables not migrated for chaining", async () => {
    const bare = `${schema}_bare`;
    await admin.query(`CREATE SCHEMA ${bare}`);
    try {
      const u = new URL(DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${bare}`);
      const err = await buildHost(deployment(), { packs: [corePack, erpPack], env: overlayEnvironment({ DATABASE_URL: u.href }, env) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeploymentError);
      expect((err as DeploymentError).problems.join("\n")).toContain("migrate:postgres");
    } finally {
      await admin.query(`DROP SCHEMA ${bare} CASCADE`);
    }
  });

  it("refuses a signing key that is not Ed25519, and an unreachable database, before serving", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const bad = await buildHost(deployment(), { packs: [corePack, erpPack], env: overlayEnvironment({ AUDIT_KEY: rsa }, env) }).catch((e: unknown) => e);
    expect((bad as DeploymentError).problems).toEqual(["state.audit.signing.key: must be an Ed25519 key"]);
    const down = await buildHost(deployment(), { packs: [corePack, erpPack], env: overlayEnvironment({ DATABASE_URL: "postgresql://nobody:x@127.0.0.1:1/none" }, env) }).catch((e: unknown) => e);
    expect((down as DeploymentError).problems.join("\n")).toContain("state.audit: cannot reach Postgres");
  });

  it.skipIf(!REDIS_URL)("two replicas share one rate budget through Redis", async () => {
    // A budget of its own, so the reads earlier tests made do not count against it.
    const own = deployment();
    const d = { ...own, state: { ...own.state, rateLimit: { ...own.state!.rateLimit!, keyPrefix: `${schema}:rl2:` } } };
    const a = await boot(d);
    const b = await boot(d);
    const who = a.personas.planner!;
    let allowed = 0;
    let refused = 0;
    for (let i = 0; i < 10; i++) {
      const h = i % 2 ? a : b;
      try {
        await h.runtime.getObject("erp.Part", "P-200", who);
        allowed += 1;
      } catch (err) {
        if (err instanceof RateLimitExceededError) refused += 1;
        else throw err;
      }
    }
    expect(allowed).toBe(6);
    expect(refused).toBe(4);
    await a.close();
    await b.close();
  });
});
