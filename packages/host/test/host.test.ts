import { describe, it, expect, afterEach } from "vitest";
import type { Adapter } from "@typesys/core";
import { corePack } from "@typesys/packs";
import { airforcePack } from "@typesys/domain-airforce";
import { airforceDeployment, airforceExtension, AIRFORCE_EXTENSION } from "@typesys/demo-web/deployments";
import { buildHost, emptyEnvironment, overlayEnvironment, adapterForSource, type Host, type HostExtension } from "../src/host.js";
import { DeploymentError, type Deployment, type HttpSourceSpec } from "../src/deployment.js";

/** ADR-0102: the generic host checks a deployment against what it is given, reports every problem, and builds one runtime. */

const hosts: Host[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
const build = async (d: Deployment, opts: Partial<Parameters<typeof buildHost>[1]> = {}) => {
  const h = await buildHost(d, { packs: [corePack, airforcePack], extensions: [airforceExtension], env: emptyEnvironment, ...opts });
  hosts.push(h);
  return h;
};
const failures = async (d: Deployment, opts: Partial<Parameters<typeof buildHost>[1]> = {}): Promise<string> => {
  try {
    await build(d, opts);
  } catch (err) {
    expect(err).toBeInstanceOf(DeploymentError);
    return (err as DeploymentError).problems.join("\n");
  }
  throw new Error("built");
};

describe("buildHost (ADR-0102)", () => {
  it("builds the airforce demonstration: its packs, its extension, its rules, its personas", async () => {
    const host = await build(airforceDeployment);
    expect(host.packs.map((p) => p.name)).toEqual(["core", "airforce"]);
    expect(host.code).toEqual({ extensions: [AIRFORCE_EXTENSION], sources: { "in-memory-airforce-repo": AIRFORCE_EXTENSION, "mock-remis-rest": AIRFORCE_EXTENSION }, manifests: [], policies: [] });
    const maintainer = await host.identityResolver("demo-maintainer-token");
    expect(maintainer.subjectId).toBe("user-maintainer-1");
    const aircraft = await host.runtime.getObject("airforce.Aircraft", "AF86-0147", maintainer);
    expect(aircraft.values.deploymentLocation).toBeDefined();
    const viewer = await host.identityResolver("demo-viewer-token");
    const seen = await host.runtime.getObject("airforce.Aircraft", "AF86-0147", viewer);
    expect(seen.values).not.toHaveProperty("deploymentLocation");
  });

  it("resolves only its own tokens: anything else, inherited names included, is anonymous", async () => {
    const host = await build(airforceDeployment);
    for (const t of ["constructor", "__proto__", "toString", "", "nope"]) expect((await host.identityResolver(t)).subjectId).toBe("anonymous");
    expect(host.personas.anonymous!.roles).toEqual([]);
  });

  it("stamps every audit row with its build id", async () => {
    const host = await build(airforceDeployment);
    expect(host.build).toMatch(/^sha256:[0-9a-f]{64}$/);
    await host.runtime.getObject("airforce.Aircraft", "AF86-0147", await host.identityResolver("demo-maintainer-token"));
    const { items } = await host.registry.listAuditEvents({ limit: 50 });
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((e) => e.build))).toEqual(new Set([host.build]));
    expect(items.some((e) => e.action === "pack.install")).toBe(true);
  });

  it("refuses packs other than the ones listed, at another version or another digest", async () => {
    expect(await failures(airforceDeployment, { packs: [corePack] })).toContain("pack airforce@1.0.0 is listed but not supplied");
    expect(await failures(airforceDeployment, { packs: [corePack, { ...airforcePack, version: "1.0.1" }] })).toContain("the deployment lists 1.0.0, 1.0.1 was supplied");
    expect(await failures(airforceDeployment, { packs: [corePack, { ...airforcePack, digest: `sha256:${"0".repeat(64)}` }] })).toContain("is not the");
    const extra = await failures({ ...airforceDeployment, packs: [airforceDeployment.packs[0]!] }, {});
    expect(extra).toContain("pack airforce is supplied but the deployment does not list it");
  });

  it("refuses an extension it does not name, and one it names that is not supplied", async () => {
    expect(await failures(airforceDeployment, { extensions: [] })).toContain(`extension "${AIRFORCE_EXTENSION}" is named by the deployment but not supplied`);
    const stray: HostExtension = { name: "@x/stray" };
    expect(await failures(airforceDeployment, { extensions: [airforceExtension, stray] })).toContain('extension "@x/stray" is supplied but the deployment does not name it');
  });

  it("refuses a source no pack declares, and an adapter for a source it does not declare", async () => {
    const extraSource = { ...airforceDeployment, sources: { ...airforceDeployment.sources, rogue: { kind: "extension" as const, extension: AIRFORCE_EXTENSION } } };
    expect(await failures(extraSource)).toContain('sources["rogue"]: no pack declares a data source with this id');
    const sneaky: HostExtension = {
      ...airforceExtension,
      adapters: async (ctx) => [...((await airforceExtension.adapters?.(ctx)) ?? []), { dataSourceId: "elsewhere" } as Adapter]
    };
    expect(await failures(airforceDeployment, { extensions: [sneaky] })).toContain('returned an adapter for "elsewhere", which the deployment does not declare');
  });

  it("refuses a code rule that would replace one of the deployment's", async () => {
    expect(await failures(airforceDeployment, { policyRules: { "airforce.read-aircraft": () => Promise.resolve({ allow: true }) } })).toContain(
      'code policy "airforce.read-aircraft" would replace the deployment\'s rule of that name'
    );
  });

  it("reports what its own extension refuses", async () => {
    await expect(build(airforceDeployment, { env: overlayEnvironment({ TYPESYS_AIRFORCE_LATENCY_MS: "soon" }, emptyEnvironment) })).rejects.toThrow("TYPESYS_AIRFORCE_LATENCY_MS");
  });
});

describe("an http source's references (ADR-0102)", () => {
  const spec: HttpSourceSpec = {
    kind: "http",
    system: "S",
    baseUrl: { $env: "S_URL" },
    auth: { kind: "client-credentials", tokenUrl: { $env: "S_URL", path: "/oauth/token" }, clientId: "c", clientSecret: { $secret: "S_SECRET", default: "demo-secret" } },
    types: { "t.T": { get: "/t/{id}", list: { path: "/t", items: "/items" }, id: "/id", fields: {} } }
  };
  const env = (v: Record<string, string>) => overlayEnvironment(v, emptyEnvironment);
  const config = (a: { config: unknown }) => a.config as { baseUrl: string; auth: { tokenUrl: string; clientSecret: string } };

  it("resolves addresses from the environment, a path against them, and the secret from the secret store", () => {
    const a = adapterForSource("s", spec, env({ S_URL: "http://svc:8080/", S_SECRET: "real" }), false) as unknown as { config: unknown };
    expect(config(a).baseUrl).toBe("http://svc:8080/");
    expect(config(a).auth.tokenUrl).toBe("http://svc:8080/oauth/token");
    expect(config(a).auth.clientSecret).toBe("real");
  });

  it("uses a secret's demonstration default only in a demo, and fails clearly without it", () => {
    expect(() => adapterForSource("s", spec, env({ S_URL: "http://svc/" }), false)).toThrow("secret S_SECRET is not set");
    expect(config(adapterForSource("s", spec, env({ S_URL: "http://svc/" }), true) as unknown as { config: unknown }).auth.clientSecret).toBe("demo-secret");
    expect(() => adapterForSource("s", spec, emptyEnvironment, true)).toThrow("environment variable S_URL is not set");
  });
});
