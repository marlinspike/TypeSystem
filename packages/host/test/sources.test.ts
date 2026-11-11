import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { AdapterUnavailableError, SourceRefusedError, type DomainManifest } from "@typesys/core";
import { toProblem } from "@typesys/http";
import { buildPack } from "@typesys/packs";
import { buildHost, emptyEnvironment, overlayEnvironment, type Host } from "../src/host.js";
import { DEPLOYMENT_FORMAT, DeploymentError, type Deployment, type PostgresTypeSpec } from "../src/deployment.js";

/**
 * ADR-0110: a deployment's declared sources are checked against the model
 * when it is built, and against the database's catalog by `checkSources`;
 * a read the database cannot answer as mapped is a named problem, not an
 * internal error. The catalog checks need DATABASE_URL.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const shop: DomainManifest = {
  domain: "shop",
  dataSources: [{ id: "shop-db", name: "Shop DB", kind: "postgres" }],
  types: [
    {
      schema: {
        $id: "https://typesys.dev/types/shop/Customer/1.0.0",
        title: "Customer",
        type: "object",
        properties: { customerId: { type: "string" }, fullName: { type: "string" }, email: { type: "string" }, tier: { type: "string" } },
        "x-policy": { objectPolicy: "shop.read", propertyPolicies: { email: "shop.contact" } }
      },
      options: { name: "shop.Customer", version: "1.0.0" }
    }
  ],
  mappings: [{ id: "map-customer", typeName: "shop.Customer", target: "property", targetName: "*", dataSourceId: "shop-db", operation: "get", resolutionMode: "live" }]
};
const shopPack = buildPack({ name: "shop", version: "1.0.0", description: "A shop's customers", manifests: [shop] });

const CUSTOMER: PostgresTypeSpec = { table: "customers", id: "customer_id", columns: { customerId: "customer_id", fullName: "full_name", email: "email", tier: "tier" } };

const deployment = (types: Record<string, PostgresTypeSpec> = { "shop.Customer": CUSTOMER }, extra: Partial<Deployment> = {}): Deployment => ({
  format: DEPLOYMENT_FORMAT,
  name: "shop",
  demo: true,
  packs: [{ name: "shop", version: "1.0.0" }],
  sources: { "shop-db": { kind: "postgres", system: "Shop DB", url: { $secret: "SHOP_URL" }, types } },
  policies: { "shop.read": { role: ["sales", "support"] }, "shop.contact": { role: ["support"] } },
  identity: { kind: "tokens", tokens: { "sales-token": "sales", "support-token": "support" } },
  personas: { sales: { subjectId: "sam", roles: ["sales"], attributes: {} }, support: { subjectId: "sue", roles: ["support"], attributes: {} } },
  ...extra
});

const problemsOf = async (d: Deployment, env = overlayEnvironment({ SHOP_URL: "postgresql://nobody@127.0.0.1:1/none" }, emptyEnvironment)): Promise<readonly string[]> => {
  const err = await buildHost(d, { packs: [shopPack], env, state: "memory" }).then(
    async (h) => {
      await h.close();
      return undefined;
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(DeploymentError);
  return (err as DeploymentError).problems;
};

describe("declared sources against the model (ADR-0110)", () => {
  it("names a mapped property the Type does not have, with the one probably meant", async () => {
    const problems = await problemsOf(deployment({ "shop.Customer": { ...CUSTOMER, columns: { ...CUSTOMER.columns, fulName: "full_name", phone: "phone" } } }));
    expect(problems).toEqual([
      'sources["shop-db"].types["shop.Customer"]: shop.Customer has no property "fulName" (did you mean "fullName"?)',
      'sources["shop-db"].types["shop.Customer"]: shop.Customer has no property "phone"'
    ]);
  });

  it("names a mapped Type no pack has", async () => {
    const problems = await problemsOf(deployment({ "shop.Customer": CUSTOMER, "shop.Custmer": CUSTOMER }));
    expect(problems).toEqual(['sources["shop-db"].types["shop.Custmer"]: no pack has a Type shop.Custmer (did you mean shop.Customer?)']);
  });

  it("names a Type mapped onto a source the model does not read it from", async () => {
    const two: DomainManifest = { ...shop, dataSources: [...shop.dataSources!, { id: "crm", name: "CRM", kind: "postgres" }] };
    const pack = buildPack({ name: "shop", version: "1.0.0", description: "Two sources", manifests: [two] });
    const d = deployment(undefined, {
      sources: {
        "shop-db": { kind: "postgres", system: "Shop DB", url: { $secret: "SHOP_URL" }, types: { "shop.Customer": CUSTOMER } },
        crm: { kind: "postgres", system: "CRM", url: { $secret: "SHOP_URL" }, types: { "shop.Customer": CUSTOMER } }
      }
    });
    const err = await buildHost(d, { packs: [pack], env: overlayEnvironment({ SHOP_URL: "postgresql://nobody@127.0.0.1:1/none" }, emptyEnvironment), state: "memory" }).catch((e: unknown) => e);
    expect((err as DeploymentError).problems).toEqual(['sources["crm"].types["shop.Customer"]: the model reads shop.Customer from shop-db, not from "crm"']);
  });

  it("reports a wrong pack digest once, not again as a source no pack declares", async () => {
    const problems = await problemsOf(deployment(undefined, { packs: [{ name: "shop", version: "1.0.0", digest: `sha256:${"0".repeat(64)}` }] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^pack shop@1\.0\.0: digest sha256:[0-9a-f]{64} is not the sha256:0{64} the deployment lists$/);
  });

  it("builds a correct deployment without reaching the database, and checkSources says the database is unreachable, not that the mapping is wrong", async () => {
    const host = await buildHost(deployment(), { packs: [shopPack], env: overlayEnvironment({ SHOP_URL: "postgresql://nobody@127.0.0.1:1/none" }, emptyEnvironment), state: "memory" });
    try {
      const err = await host.checkSources().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdapterUnavailableError);
      expect((err as Error).message).toBe('sources["shop-db"]: Shop DB cannot be reached or is too busy to answer for shop.Customer now');
      // The driver's text, with the address in it, is kept for the log only (5.0 pressure test of ADR-0110, M3).
      expect(toProblem(err).detail).not.toContain("127.0.0.1");
    } finally {
      await host.close();
    }
  });
});

describe.skipIf(!DATABASE_URL)("declared sources against the database (ADR-0110)", () => {
  const schema = `srcchk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url = (() => {
    const u = new URL(DATABASE_URL ?? "postgresql://localhost/x");
    u.searchParams.set("options", `-c search_path=${schema}`);
    return u.href;
  })();
  const role = `${schema}_reader`;
  // Made per run: a throwaway role in a throwaway schema, never a fixed credential in the source.
  const rolePassword = randomBytes(12).toString("hex");
  const readerUrl = (() => {
    const u = new URL(url);
    u.username = role;
    u.password = rolePassword;
    return u.href;
  })();
  let admin: pg.Pool;
  const hosts: Host[] = [];
  const boot = async (d: Deployment, as = url) => {
    const h = await buildHost(d, { packs: [shopPack], env: overlayEnvironment({ SHOP_URL: as }, emptyEnvironment), state: "memory" });
    hosts.push(h);
    return h;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.customers (customer_id text PRIMARY KEY, full_name text, email text, tier text);
      INSERT INTO ${schema}.customers VALUES ('C-1', 'Ada Lovelace', 'ada@example.com', 'gold');
      CREATE TABLE ${schema}.secrets (customer_id text PRIMARY KEY, full_name text, email text, tier text);
      CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}';
      GRANT USAGE ON SCHEMA ${schema} TO ${role};
      GRANT SELECT ON ${schema}.customers TO ${role};
      CREATE TABLE ${schema}.partial (customer_id text PRIMARY KEY, full_name text, email text, tier text);
      INSERT INTO ${schema}.partial VALUES ('C-1', 'Ada Lovelace', 'ada@example.com', 'gold');
      GRANT SELECT (customer_id, full_name, tier) ON ${schema}.partial TO ${role};`);
  });

  afterAll(async () => {
    await Promise.allSettled(hosts.map((h) => h.close()));
    await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("finds nothing wrong with a mapping that matches, and reads through it", async () => {
    const host = await boot(deployment());
    expect(await host.checkSources()).toEqual([]);
    expect((await host.runtime.getObject("shop.Customer", "C-1", host.personas.support!)).values).toMatchObject({ fullName: "Ada Lovelace", email: "ada@example.com" });
  });

  it("names a missing table, id column and property column, each with the name probably meant", async () => {
    const host = await boot(deployment({ "shop.Customer": { ...CUSTOMER, id: "customerid", columns: { ...CUSTOMER.columns, tier: "tierz" } } }));
    expect(await host.checkSources()).toEqual([
      'sources["shop-db"]: shop.Customer: customers has no id column "customerid" (did you mean "customer_id"?)',
      'sources["shop-db"]: shop.Customer.tier: customers has no column "tierz" (did you mean "tier"?)'
    ]);
    const missing = await boot(deployment({ "shop.Customer": { ...CUSTOMER, table: `${schema}.customer` } }));
    expect(await missing.checkSources()).toEqual([`sources["shop-db"]: shop.Customer: Shop DB has no table or view "${schema}.customer" (did you mean "${schema}.customers"?)`]);
  });

  it("turns a read the mapping cannot answer into a named, non-retryable unavailable problem, with the database's message kept for the log only", async () => {
    const host = await boot(deployment({ "shop.Customer": { ...CUSTOMER, columns: { ...CUSTOMER.columns, tier: "tierz" } } }));
    const err = await host.runtime.getObject("shop.Customer", "C-1", host.personas.support!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterUnavailableError);
    expect((err as AdapterUnavailableError).retryable).toBe(false);
    const problem = toProblem(err);
    expect(problem).toMatchObject({ status: 503, code: "unavailable" });
    expect(problem.detail).toBe("Shop DB could not answer for shop.Customer: the deployment's mapping of it names a table or column the database does not have (typesys deploy build lists which)");
    expect(problem.detail).not.toContain("tierz");
    expect(String((err as { cause?: unknown }).cause)).toContain("tierz");
  });

  it("reports a table the connection may not read, and a read of it is the source's refusal", async () => {
    const host = await boot(deployment({ "shop.Customer": { ...CUSTOMER, table: "secrets" } }), readerUrl);
    expect(await host.checkSources()).toEqual(['sources["shop-db"]: shop.Customer: the connection may not read secrets (it lacks SELECT on it)']);
    const err = await host.runtime.getObject("shop.Customer", "C-1", host.personas.support!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceRefusedError);
    expect(toProblem(err)).toMatchObject({ status: 502, code: "source-refused" });
  });

  it("accepts a column-level grant covering every column the mapping reads, and names only the columns it does not cover", async () => {
    const { email: _email, ...withoutEmail } = CUSTOMER.columns;
    const covered = await boot(deployment({ "shop.Customer": { ...CUSTOMER, table: "partial", columns: withoutEmail } }), readerUrl);
    expect(await covered.checkSources()).toEqual([]);
    expect((await covered.runtime.getObject("shop.Customer", "C-1", covered.personas.support!)).values).toMatchObject({ fullName: "Ada Lovelace" });
    const uncovered = await boot(deployment({ "shop.Customer": { ...CUSTOMER, table: "partial" } }), readerUrl);
    expect(await uncovered.checkSources()).toEqual(['sources["shop-db"]: shop.Customer: the connection may not read email of partial (it lacks SELECT on that column)']);
  });
});

describe("readiness is the state's, not every source's (ADR-0123)", () => {
  it("stays ready while a declared source cannot be reached, which answers 503 for its own Types", async () => {
    const host = await buildHost(deployment(), { packs: [shopPack], env: overlayEnvironment({ SHOP_URL: "postgresql://nobody@127.0.0.1:1/none" }, emptyEnvironment), state: "memory" });
    try {
      await expect(host.state.ready()).resolves.toBeUndefined();
      const sales = host.personas.sales!;
      const err = await host.runtime.getObject("shop.Customer", "C1", sales).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdapterUnavailableError);
      expect(toProblem(err).status).toBe(503);
    } finally {
      await host.close();
    }
  });
});
