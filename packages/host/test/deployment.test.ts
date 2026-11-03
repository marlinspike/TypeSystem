import { describe, it, expect } from "vitest";
import { DEPLOYMENT_FORMAT, buildIdOf, parseDeployment, validateDeployment, DeploymentError, type Deployment } from "../src/deployment.js";

/** ADR-0102: a deployment is data, checked before anything is built, with every problem named. */

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
  policies: { "t.read": { role: ["reader"] } },
  identity: { kind: "oidc", issuer: { $env: "ISSUER" } }
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
    expect(problems({ ...tokens, demo: true, personas: {} })).toContain("names no persona");
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
    const reordered = JSON.parse(JSON.stringify({ policies: base.policies, identity: base.identity, sources: base.sources, packs: base.packs, name: base.name, format: base.format })) as Deployment;
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
});
