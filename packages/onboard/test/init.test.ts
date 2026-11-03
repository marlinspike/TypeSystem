import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPack } from "@typesys/packs";
import type { DomainManifest } from "@typesys/core";
import { draftDeployment, initCommand, onboardCommand, packRules, updateDeployment, type AdapterPlan, type DraftDeployment } from "../src/index.js";

/**
 * ADR-0111: a database onboarded straight into a deployment. The drafting is
 * pure and runs everywhere; `typesys init --from postgres` end to end needs
 * DATABASE_URL, and the deployment it writes is built and tested by the
 * generic host's own commands.
 */
const url = process.env.DATABASE_URL;

const manifest: DomainManifest = {
  domain: "shop",
  dataSources: [{ id: "shop-db", name: "Shop DB", kind: "postgres" }],
  types: [
    {
      schema: {
        $id: "urn:typesys:type:shop.Customer:1.0.0",
        title: "Customer",
        type: "object",
        properties: { customerId: { type: "string" }, email: { type: "string" } },
        "x-policy": { objectPolicy: "shop.read-customer", propertyPolicies: { email: "shop.contact" } }
      },
      options: { name: "shop.Customer", version: "1.0.0" }
    }
  ],
  actions: [
    {
      id: "a",
      name: "CloseAccount",
      version: "1.0.0",
      description: "Close it.",
      applicableTypes: ["shop.Customer"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      authorizationPolicy: "shop.invoke-close-account",
      preconditions: [],
      implementation: { dataSourceId: "shop-db", operation: "close" },
      sideEffects: "mutates",
      idempotency: "natural",
      auditRequired: true
    }
  ],
  mappings: [{ id: "m", typeName: "shop.Customer", target: "property", targetName: "*", dataSourceId: "shop-db", operation: "get", resolutionMode: "live" }]
};
const pack = buildPack({ name: "shop", version: "1.0.0", description: "shop, onboarded from Shop DB", manifests: [manifest] });
const plans: AdapterPlan[] = [{ kind: "postgres-table", dataSourceId: "shop-db", system: "Shop DB", connectionEnv: "SHOP_DB_URL", types: { "shop.Customer": { table: "public.customers", id: "customer_id", columns: { customerId: "customer_id", email: "email" } } } }];

describe("drafting a deployment from an onboarded pack (ADR-0111)", () => {
  it("sorts the pack's rules into read, sensitive and invoke", () => {
    expect(packRules(pack)).toEqual({ read: ["shop.read-customer"], sensitive: ["shop.contact"], invoke: ["shop.invoke-close-account"] });
  });

  it("gives each kind of rule one role, nothing open to everyone, and a persona with a fresh token for each role", () => {
    const a = draftDeployment(pack, plans, { name: "shop", packFile: "packs/shop-1.0.0.typesys-pack.json", connectionEnv: { "shop-db": "SHOP_URL" } });
    const b = draftDeployment(pack, plans, { name: "shop", packFile: "packs/shop-1.0.0.typesys-pack.json" });
    expect(a.deployment.policies).toEqual({ "shop.read-customer": { role: ["reader"] }, "shop.contact": { role: ["steward"] }, "shop.invoke-close-account": { role: ["operator"] } });
    expect(JSON.stringify(a.deployment.policies)).not.toContain("always");
    expect(a.deployment.personas).toEqual({
      reader: { subjectId: "dev-reader", roles: ["reader"], attributes: {} },
      steward: { subjectId: "dev-steward", roles: ["reader", "steward"], attributes: {} },
      operator: { subjectId: "dev-operator", roles: ["reader", "operator"], attributes: {} }
    });
    expect(Object.keys(a.tokens)).toEqual(["reader", "steward", "operator"]);
    for (const t of Object.values(a.tokens)) expect(t).toMatch(/^dev-(reader|steward|operator)-[A-Za-z0-9_-]{12}$/);
    expect(a.tokens.reader).not.toBe(b.tokens.reader);
    expect(a.deployment.identity).toEqual({ kind: "tokens", tokens: Object.fromEntries(Object.entries(a.tokens).map(([p, t]) => [t, p])) });
    expect(a.deployment.demo).toBe(true);
    expect(a.deployment.packs).toEqual([{ name: "shop", version: "1.0.0", digest: pack.digest, file: "packs/shop-1.0.0.typesys-pack.json" }]);
    expect(a.deployment.sources).toEqual({ "shop-db": { kind: "postgres", system: "Shop DB", url: { $secret: "SHOP_URL" }, types: plans[0]!.types } });
    expect((b.deployment.sources["shop-db"] as { url: unknown }).url).toEqual({ $secret: "SHOP_DB_URL" });
  });

  it("drafts no operator when the model has no Actions, and refuses a source it cannot declare", () => {
    const readOnly = buildPack({ name: "shop", version: "1.0.0", description: "x", manifests: [{ ...manifest, actions: [] }] });
    expect(Object.keys(draftDeployment(readOnly, plans, { name: "shop", packFile: "p" }).deployment.personas!)).toEqual(["reader", "steward"]);
    const http = [{ kind: "http", dataSourceId: "api", system: "API", baseUrlEnv: "API_URL", types: {}, actions: {} }] as AdapterPlan[];
    expect(() => draftDeployment(pack, http, { name: "shop", packFile: "p" })).toThrow(/PostgreSQL sources only/);
  });

  it("updates a deployment with a re-onboarded pack: new digest and mapping, connection kept, a draft rule only for a new rule, existing rules untouched", () => {
    const { deployment } = draftDeployment(pack, plans, { name: "shop", packFile: "packs/shop-1.0.0.typesys-pack.json", connectionEnv: { "shop-db": "SHOP_URL" } });
    const edited: DraftDeployment = { ...deployment, policies: { ...deployment.policies, "shop.contact": { role: ["support"] }, "shop.legacy": { role: ["x"] } } };
    const grown: DomainManifest = {
      ...manifest,
      types: [{ ...manifest.types[0]!, schema: { ...manifest.types[0]!.schema, properties: { ...manifest.types[0]!.schema.properties, phone: { type: "string" } }, "x-policy": { objectPolicy: "shop.read-customer", propertyPolicies: { email: "shop.contact", phone: "shop.phone" } } } }]
    };
    const pack2 = buildPack({ name: "shop", version: "1.1.0", description: "x", manifests: [grown] });
    const plans2: AdapterPlan[] = [{ ...plans[0]!, types: { "shop.Customer": { ...(plans[0] as { types: Record<string, never> }).types["shop.Customer"], table: "public.customers", id: "customer_id", columns: { customerId: "customer_id", email: "email", phone: "phone" } } } } as AdapterPlan];
    const u = updateDeployment(edited, pack2, plans2, "packs/shop-1.1.0.typesys-pack.json");
    expect(u.deployment.packs).toEqual([{ name: "shop", version: "1.1.0", digest: pack2.digest, file: "packs/shop-1.1.0.typesys-pack.json" }]);
    expect(u.addedPolicies).toEqual(["shop.phone"]);
    expect(u.deployment.policies["shop.phone"]).toEqual({ role: ["steward"] });
    expect(u.deployment.policies["shop.contact"]).toEqual({ role: ["support"] });
    expect(u.unusedPolicies).toEqual(["shop.legacy"]);
    expect(u.deployment.policies["shop.legacy"]).toEqual({ role: ["x"] });
    const source = u.deployment.sources["shop-db"] as { url: unknown; types: Record<string, { columns: Record<string, string> }> };
    expect(source.url).toEqual({ $secret: "SHOP_URL" });
    expect(source.types["shop.Customer"]!.columns.phone).toBe("phone");
    expect(u.changes).toEqual([`pack shop 1.0.0 → 1.1.0 (${pack2.digest.slice(0, 19)}…)`, 'sources["shop-db"]: mapping updated']);
    expect(updateDeployment(u.deployment, pack2, plans2, "packs/shop-1.1.0.typesys-pack.json").changes).toEqual([]);
  });

  it("refuses to put a PostgreSQL mapping onto a source the deployment declares as something else", () => {
    const { deployment } = draftDeployment(pack, plans, { name: "shop", packFile: "p" });
    const other: DraftDeployment = { ...deployment, sources: { "shop-db": { kind: "http", system: "x", baseUrl: "http://x", types: {} } } };
    expect(() => updateDeployment(other, pack, plans, "p")).toThrow(/is a http source in the deployment/);
  });

  it("init explains itself and refuses what it cannot do before touching anything", async () => {
    const lines: string[] = [];
    expect(await initCommand(["--help"], (s) => lines.push(s))).toBe(0);
    expect(lines[0]).toContain("typesys init <dir> --from postgres <ENV_VAR> --schema <name>");
    const say = (s: string) => lines.push(s);
    expect(await initCommand(["d", "--from", "postgres", "NOPE_URL", "--schema", "public"], say, {})).toBe(1);
    expect(lines.at(-1)).toBe("FAIL — NOPE_URL is not set: export it with the database's connection string, then run init again");
    expect(await initCommand(["d", "--from", "postgres", "X", "--schema", "public", "--domain", "Bad-Name"], say, { X: "postgres://x" })).toBe(1);
    expect(lines.at(-1)).toMatch(/--domain must be lowercase letters and digits/);
    expect(await initCommand(["d", "--from", "postgres", "X"], say, { X: "postgres://x" })).toBe(1);
    expect(lines.at(-1)).toMatch(/needs at least one --schema/);
    expect(await initCommand(["d", "--from", "mysql", "X"], say, {})).toBe(2);
  });
});

describe.skipIf(!url)("typesys init --from postgres, end to end (ADR-0111)", () => {
  const schema = `init_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let admin: pg.Pool;
  const dirs: string[] = [];
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.customers (customer_id text PRIMARY KEY, full_name text NOT NULL, email text, tier text);
      INSERT INTO ${schema}.customers VALUES ('C-1', 'Ada Lovelace', 'ada@example.com', 'gold'), ('C-2', 'Grace Hopper', 'grace@example.com', 'platinum');
      CREATE TABLE ${schema}.orders (order_id text PRIMARY KEY, customer_id text REFERENCES ${schema}.customers, total numeric(10,2));
      INSERT INTO ${schema}.orders VALUES ('O-1', 'C-1', 120.50);`);
  });
  afterAll(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("writes a deployment the generic host builds, checks against the database and serves governed, with passing drafted tests", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "typesys-init-")), "shop");
    dirs.push(path.dirname(dir));
    const out: string[] = [];
    const env = { SHOP_URL: url };
    expect(await initCommand([dir, "--from", "postgres", "SHOP_URL", "--schema", schema], (s) => out.push(s), env)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain('into "shop": 2 Types');
    expect(text).toMatch(/reader\s+dev-reader-/);
    expect(text).toContain(`npx typesys dev ${path.join(dir, "shop.deployment.json")}`);
    for (const f of ["shop.deployment.json", "shop.tests.json", "README.md", "packs/shop-1.0.0.typesys-pack.json", "onboarding/review.json", "onboarding/sources.json"]) expect(existsSync(path.join(dir, f))).toBe(true);
    const written = readFileSync(path.join(dir, "shop.deployment.json"), "utf8");
    // The connection string is referred to by name, never written.
    expect(written).not.toContain(url!);
    expect(JSON.parse(written).sources["shop-db"].url).toEqual({ $secret: "SHOP_URL" });
    // No value from a row is written into the tests.
    const tests = readFileSync(path.join(dir, "shop.tests.json"), "utf8");
    for (const v of ["C-1", "Ada", "ada@example.com", "gold"]) expect(tests).not.toContain(v);

    // The generic host's own commands accept what init wrote.
    const { deployCommand, hostFromFile, overlayEnvironment, processEnvironment } = await import("@typesys/host");
    process.env.SHOP_URL = url;
    try {
      expect(await deployCommand(["build", path.join(dir, "shop.deployment.json")])).toBe(0);
      expect(await deployCommand(["test", path.join(dir, "shop.deployment.json")])).toBe(0);
      const host = await hostFromFile(path.join(dir, "shop.deployment.json"), overlayEnvironment({ SHOP_URL: url }, processEnvironment));
      try {
        expect(await host.checkSources()).toEqual([]);
        const reader = (await host.runtime.getObject("shop.Customer", "C-1", host.personas.reader!)).values;
        const steward = (await host.runtime.getObject("shop.Customer", "C-1", host.personas.steward!)).values;
        expect(reader).not.toHaveProperty("email");
        expect(reader).not.toHaveProperty("fullName");
        expect(steward).toMatchObject({ email: "ada@example.com", fullName: "Ada Lovelace" });
        await expect(host.runtime.getObject("shop.Customer", "C-1", host.personas.anonymous!)).rejects.toThrow(/Not authorized/);
      } finally {
        await host.close();
      }
    } finally {
      delete process.env.SHOP_URL;
    }

    // Running init again would overwrite a deployment someone may have edited: refused without --force.
    const again: string[] = [];
    expect(await initCommand([dir, "--from", "postgres", "SHOP_URL", "--schema", schema], (s) => again.push(s), env)).toBe(1);
    expect(again.at(-1)).toMatch(/shop\.deployment\.json exists: change it with typesys onboard propose --deployment, or pass --force/);
  });

  it("onboard propose --deployment brings a new column into the deployment and leaves its rules alone", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "typesys-init-")), "shop");
    dirs.push(path.dirname(dir));
    const env = { SHOP_URL: url };
    expect(await initCommand([dir, "--from", "postgres", "SHOP_URL", "--schema", schema], () => undefined, env)).toBe(0);
    const file = path.join(dir, "shop.deployment.json");
    const before = JSON.parse(readFileSync(file, "utf8")) as DraftDeployment;
    await admin.query(`ALTER TABLE ${schema}.customers ADD COLUMN region text`);
    try {
      const on = path.join(dir, "onboarding");
      expect(await onboardCommand(["collect", "--postgres", "SHOP_URL", "--schema", schema, "--source", "shop-db", "--out", path.join(on, "sources.json")], () => undefined, env)).toBe(0);
      expect(await onboardCommand(["review", on, "--review", path.join(on, "review.json"), "--by", "test"], () => undefined, env)).toBe(0);
      const out: string[] = [];
      expect(
        await onboardCommand(
          ["propose", path.join(on, "sources.json"), "--domain", "shop", "--out", on, "--review", path.join(on, "review.json"), "--approved", path.join(on, "approved.json"), "--previous", path.join(on, "pack.json"), "--version", "1.1.0", "--deployment", file],
          (s) => out.push(s),
          env
        )
      ).toBe(0);
      const after = JSON.parse(readFileSync(file, "utf8")) as DraftDeployment;
      expect(after.packs[0]).toMatchObject({ name: "shop", version: "1.1.0", file: "packs/shop-1.1.0.typesys-pack.json" });
      expect(existsSync(path.join(dir, "packs/shop-1.1.0.typesys-pack.json"))).toBe(true);
      expect(after.policies).toEqual(before.policies);
      expect(after.identity).toEqual(before.identity);
      expect(out.join("\n")).toContain(`deployment ${file}: pack shop 1.0.0 → 1.1.0`);
    } finally {
      await admin.query(`ALTER TABLE ${schema}.customers DROP COLUMN region`);
    }
  });
});
