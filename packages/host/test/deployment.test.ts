import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { DEPLOYMENT_FORMAT, buildIdOf, parseDeployment, validateDeployment, DeploymentError, type Deployment } from "../src/deployment.js";

/** ADR-0102: a deployment is data, checked before anything is built, with every problem named. */

const auditPublicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

const base: Deployment = {
  format: DEPLOYMENT_FORMAT,
  name: "t",
  packs: [{ name: "core", version: "1.0.0" }],
  sources: {
    s: {
      kind: "http",
      system: "S",
      baseUrl: { $env: "S_URL" },
      auth: { kind: "header", name: "x-key", value: { $secret: "S_KEY" } },
      types: { "t.T": { get: "/t/{id}", list: { path: "/t", items: "/items" }, id: "/id", fields: { a: "/a" } } }
    }
  },
  state: {
    audit: { kind: "postgres", url: { $secret: "DATABASE_URL" }, signing: { keyId: "audit-1", key: { $secret: "AUDIT_KEY" } }, verifyKeys: { "audit-1": auditPublicKey } }
  },
  policies: { "t.read": { role: ["reader"] } },
  identity: { kind: "oidc", issuer: { $env: "ISSUER" }, audience: "https://typesys.example" }
};

const problems = (patch: Record<string, unknown>) => validateDeployment({ ...base, ...patch }).join("\n");

describe("a deployment document (ADR-0102)", () => {
  it("accepts a well formed one", () => {
    expect(validateDeployment(base)).toEqual([]);
    expect(parseDeployment(base)).toBe(base);
  });

  it("refuses unknown fields, a wrong format, a bad name and an empty pack list, all at once", () => {
    const all = validateDeployment({ ...base, format: "typesys.deployment/2", name: "Bad Name", packs: [], surprise: 1 });
    expect(all.join("\n")).toContain('unknown field "surprise"');
    expect(all.join("\n")).toContain("format: must be");
    expect(all.join("\n")).toContain("name:");
    expect(all.join("\n")).toContain("packs: must list at least one pack");
    expect(() => parseDeployment({ ...base, packs: [] })).toThrow(DeploymentError);
  });

  it("holds credentials only as references, unless it is a demo", () => {
    const literal = { s: { ...base.sources.s, auth: { kind: "header", name: "x-key", value: "hunter2" } } };
    expect(problems({ sources: literal })).toContain("a credential must be a");
    expect(problems({ sources: literal, demo: true })).toBe("");
    const defaulted = { s: { ...base.sources.s, auth: { kind: "header", name: "x-key", value: { $secret: "S_KEY", default: "well-known" } } } };
    expect(problems({ sources: defaulted })).toContain("a default credential is allowed only in a demo deployment");
    expect(problems({ sources: defaulted, demo: true })).toBe("");
  });

  it("allows fixed tokens and the demonstration classification only in a demo", () => {
    const tokens = { identity: { kind: "tokens", tokens: { abc: "p" } }, personas: { p: { subjectId: "p", roles: [], attributes: {} } } };
    expect(problems(tokens)).toContain("allowed only in a demo deployment");
    expect(problems({ ...tokens, demo: true })).toBe("");
    expect(problems({ ...tokens, demo: true, personas: {} })).toContain("names persona \"p\", which personas does not declare");
    expect(problems({ classification: { kind: "demo-linear" } })).toContain("allowed only in a demo deployment");
    expect(problems({ classification: { kind: "linear", name: "c", levels: ["A", "A"] } })).toContain("distinct markings");
  });

  it("checks its policies as policy expressions, and an inspection policy names one of them", () => {
    expect(problems({ policies: { "t.read": { role: [] } } })).toContain('policies["t.read"].role');
    expect(problems({ runtime: { inspectionPolicy: "t.missing" } })).toContain("runtime.inspectionPolicy");
    expect(problems({ runtime: { inspectionPolicy: "t.read" } })).toBe("");
  });

  it("names the extensions its code comes from, and an extension source must name one of them", () => {
    expect(problems({ sources: { s: { kind: "extension", extension: "@x/y" } } })).toContain('"@x/y" is not among the deployment\'s extensions');
    expect(problems({ extensions: ["@x/y"], sources: { s: { kind: "extension", extension: "@x/y" } } })).toBe("");
  });

  it("refuses a malformed pack digest and a pack listed twice", () => {
    expect(problems({ packs: [{ name: "core", version: "1.0.0", digest: "md5:x" }] })).toContain("digest: must be sha256");
    expect(problems({ packs: [{ name: "core", version: "1.0.0" }, { name: "core", version: "1.0.1" }] })).toContain("listed twice");
  });

  it("checks consumers' contracts", () => {
    expect(problems({ consumers: [{ name: "app", contract: { "t.T": "^1.0.0" } }] })).toBe("");
    expect(problems({ consumers: [{ name: "app", contract: { "t.T": "" } }] })).toContain("semver range");
    expect(problems({ consumers: [{ name: "app", contract: {} }, { name: "app", contract: {} }] })).toContain("listed twice");
  });
});

describe("the build id (ADR-0101)", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  it("is the same for the same deployment and packs, in any key or pack order", () => {
    const reordered = JSON.parse(JSON.stringify({ policies: base.policies, state: base.state, identity: base.identity, sources: base.sources, packs: base.packs, name: base.name, format: base.format })) as Deployment;
    expect(buildIdOf(reordered, [digest, "sha256:b"])).toBe(buildIdOf(base, ["sha256:b", digest]));
    expect(buildIdOf(base, [digest])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes with the packs or the rules, and not with the value a secret resolves to", () => {
    const id = buildIdOf(base, [digest]);
    expect(buildIdOf(base, [`sha256:${"b".repeat(64)}`])).not.toBe(id);
    expect(buildIdOf({ ...base, policies: { "t.read": { role: ["reader", "auditor"] } } }, [digest])).not.toBe(id);
    // The deployment holds only the reference; what S_KEY is set to never reaches the hash.
    expect(JSON.stringify(base)).not.toContain("hunter2");
  });

  it("keeps and signs its audit trail unless it is a demo (ADR-0106)", () => {
    expect(problems({ state: undefined })).toContain("a deployment that is not a demo must keep its audit trail");
    expect(problems({ state: { audit: { kind: "memory" } } })).toContain("must keep its audit trail");
    expect(problems({ state: undefined, demo: true })).toBe("");
    expect(problems({ state: { audit: { kind: "postgres", url: { $secret: "DATABASE_URL" } } } })).toContain("must sign its audit checkpoints");
    expect(problems({ state: { audit: { kind: "postgres", url: { $secret: "DATABASE_URL" } } }, demo: true })).toBe("");
    expect(problems({ state: { audit: { kind: "postgres", url: "postgresql://u:p@db/x", signing: { keyId: "audit-1", key: { $secret: "K" } }, verifyKeys: { "audit-1": auditPublicKey } } } })).toContain("a credential must be a");
    expect(problems({ state: { audit: { kind: "postgres", url: { $secret: "D" }, signing: { keyId: "other", key: { $secret: "K" } }, verifyKeys: { "audit-1": auditPublicKey } } } })).toContain('must hold the public key for "other"');
    expect(problems({ state: { audit: { kind: "postgres", url: { $secret: "D" }, signing: { keyId: "audit-1", key: { $secret: "K" } }, verifyKeys: { "audit-1": "not a key" } } } })).toContain("verifyKeys: must map key ids to PEM public keys");
    expect(problems({ state: { ...base.state, audit: { ...base.state!.audit!, retainDays: 0 } } })).toContain("retainDays");
  });

  it("checks the rest of its state (ADR-0106)", () => {
    const with_ = (extra: Record<string, unknown>) => problems({ state: { ...base.state, ...extra } });
    expect(with_({ workflows: { kind: "postgres", url: { $secret: "DATABASE_URL" } }, cache: { kind: "redis", url: { $secret: "REDIS_URL" } }, rateLimit: { kind: "redis", url: { $secret: "REDIS_URL" }, capacity: 100, refillPerSecond: 50 } })).toBe("");
    expect(with_({ workflows: { kind: "mongo" } })).toContain('state.workflows.kind: must be "memory" or "postgres"');
    expect(with_({ cache: { kind: "memory", url: "x" } })).toContain('state.cache: unknown field "url"');
    expect(with_({ rateLimit: { kind: "redis", capacity: 0, refillPerSecond: -1 } })).toMatch(/state.rateLimit.url[\s\S]*capacity[\s\S]*refillPerSecond/);
    expect(with_({ rateLimit: { kind: "memory", url: { $secret: "R" }, capacity: 1, refillPerSecond: 1 } })).toContain("only a redis rate limit has one");
    expect(with_({ surprise: {} })).toContain('state: unknown field "surprise"');
    expect(problems({ runtime: { securityProfile: "lax" } })).toContain("runtime.securityProfile");
  });

  it("separates the server's role from the tables' owner, and sets discovery (ADR-0124)", () => {
    const audit = { ...base.state!.audit!, ownerUrl: { $secret: "STATE_OWNER_URL" } };
    expect(problems({ state: { audit, workflows: { kind: "postgres", url: { $secret: "DATABASE_URL" }, ownerUrl: { $secret: "STATE_OWNER_URL" } } } })).toBe("");
    expect(problems({ state: { audit: { ...audit, ownerUrl: "postgres://owner@db/x" } } })).toContain("state.audit.ownerUrl: a credential must be a");
    expect(problems({ state: { audit, workflows: { kind: "memory", ownerUrl: { $secret: "X" } } } })).toContain('state.workflows: unknown field "ownerUrl"');
    for (const discovery of ["open", "authenticated", "need-to-know"]) expect(problems({ runtime: { discovery } })).toBe("");
    expect(problems({ runtime: { discovery: "closed" } })).toContain('runtime.discovery: must be "open", "authenticated" or "need-to-know"');
    expect(problems({ runtime: { securityProfile: "high-assurance-v2" } })).toBe("");
    expect(problems({ runtime: { securityProfile: "high-assurance-v2", discovery: "open" } })).toContain('high-assurance-v2 requires "need-to-know"');
  });

  it("declares postgres sources as data (ADR-0107)", () => {
    const pg = { kind: "postgres", system: "Legacy ERP", url: { $secret: "ERP_URL" }, types: { "t.T": { table: "erp.parts", id: "part_no", columns: { a: "descr", b: { column: "qty", as: "integer" } } } } };
    expect(problems({ sources: { ...base.sources, erp: pg } })).toBe("");
    expect(problems({ sources: { erp: { ...pg, url: "postgresql://u:p@h/db" } } })).toContain("a credential must be a");
    expect(problems({ sources: { erp: { ...pg, types: { "t.T": { table: "parts; drop", id: "x", columns: {} } } } } })).toContain(".table: must be a table name");
    expect(problems({ sources: { erp: { ...pg, types: { "t.T": { table: "p", id: "x", columns: { a: { column: "q", as: "money" } } } } } } })).toContain(".as: must be one of");
  });

  it("names its applications (ADR-0108)", () => {
    expect(problems({ applications: [{ name: "recall-response", port: { $env: "RECALL_PORT", default: "4700" } }] })).toBe("");
    expect(problems({ applications: [{ name: "a", port: "1" }, { name: "a", port: "2" }] })).toContain("a is listed twice");
    expect(problems({ applications: [{ name: "A b", port: "1", extra: 1 }] })).toMatch(/applications\[0\]: unknown field "extra"[\s\S]*name/);
  });
});
