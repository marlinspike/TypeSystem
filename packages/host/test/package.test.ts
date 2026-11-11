import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { loadDeployment, loadExtensions } from "../src/load.js";
import { buildHost } from "../src/host.js";
import { packageCommand, packageDeployment } from "../src/package.js";
import { promoteCommand } from "../src/promote.js";
import { deployCommand } from "../src/cli.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** A shop deployment as typesys init writes one (its pack beside it, by file), promoted to a shared one. */
let dir: string;
let shared: string;

const hasCompose = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "typesys-package-"));
  mkdirSync(path.join(dir, "packs"));
  // The airforce pack stands in for an onboarded one: what matters is that it is found by `file`, beside the deployment.
  writeFileSync(path.join(dir, "packs", "airforce-1.0.0.typesys-pack.json"), readFileSync(path.join(root, "packs", "airforce-1.0.0.typesys-pack.json")));
  const airforce = JSON.parse(readFileSync(path.join(root, "deployments", "airforce.deployment.json"), "utf8")) as Record<string, unknown> & { packs: { name: string }[] };
  const dev = { ...airforce, packs: airforce.packs.map((p) => (p.name === "airforce" ? { ...p, file: "packs/airforce-1.0.0.typesys-pack.json" } : p)) };
  writeFileSync(path.join(dir, "fleet.deployment.json"), JSON.stringify(dev, null, 2));
  expect(await promoteCommand([path.join(dir, "fleet.deployment.json"), "--issuer", "OIDC_ISSUER", "--audience", "typesys-fleet"], () => undefined, () => undefined)).toBe(0);
  shared = path.join(dir, "fleet.shared.deployment.json");
  // What promote reports as still to change: the demo's classification ordering.
  const doc = JSON.parse(readFileSync(shared, "utf8")) as Record<string, unknown>;
  writeFileSync(shared, JSON.stringify({ ...doc, classification: { kind: "linear", name: "fleet", levels: ["UNCLASSIFIED", "CUI", "SECRET", "TOP SECRET"] } }, null, 2));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("typesys deploy package (ADR-0119)", () => {
  it("writes a Compose project: state database, migrate first, the deployment and its packs as they are, the signing key as a file", async () => {
    const r = await packageDeployment(shared, { target: "compose", packsDir: path.join(root, "packs"), hosts: ["fleet.example.com"], image: "typesys:test" });
    const out = r.out;
    expect(out).toBe(path.join(dir, "deploy-compose"));
    const compose = yaml.load(readFileSync(path.join(out, "compose.yaml"), "utf8")) as { services: Record<string, Record<string, unknown>>; secrets: Record<string, { file: string }> };
    expect(Object.keys(compose.services)).toEqual(["state-db", "migrate", "app", "audit-verify"]);
    // ADR-0124: the server signs in as a role of its own; only the database and migrate read the owner's file.
    expect(compose.services["state-db"]!.env_file).toEqual(["owner.env"]);
    expect(compose.services.migrate!.env_file).toEqual([".env", "owner.env"]);
    expect(compose.services.app!.env_file).toEqual([".env"]);
    expect(compose.services.app!.ports).toEqual(["${TYPESYS_BIND:-127.0.0.1}:${TYPESYS_PORT:-3939}:3939"]);
    const ownerEnv = readFileSync(path.join(out, "owner.env"), "utf8");
    const pw = /^POSTGRES_PASSWORD=([0-9a-f]{48})$/m.exec(ownerEnv)![1]!;
    expect(ownerEnv).toContain(`TYPESYS_STATE_OWNER_URL=postgresql://typesys:${pw}@state-db:5432/typesys\n`);
    expect(statSync(path.join(out, "owner.env")).mode & 0o777).toBe(0o600);
    // The verifier: no private key, a witness in a volume of its own.
    const verify = compose.services["audit-verify"]!;
    expect(verify.secrets).toBeUndefined();
    expect(verify.environment).not.toHaveProperty("TYPESYS_AUDIT_SIGNING_KEY_FILE");
    expect(verify.command).toEqual(["node", "packages/cli/dist/bin.js", "audit", "verify", "/etc/typesys/fleet.shared.deployment.json", "--witness", "/var/lib/typesys/audit-witness.json"]);
    expect(verify.volumes).toContain("audit-witness:/var/lib/typesys");
    const app = compose.services.app!;
    expect(app.image).toBe("typesys:test");
    expect(app.environment).toMatchObject({
      TYPESYS_DEPLOYMENT: "/etc/typesys/fleet.shared.deployment.json",
      TYPESYS_STATE_URL: "postgresql://typesys_app:${STATE_APP_PASSWORD:?set STATE_APP_PASSWORD in .env}@state-db:5432/typesys",
      TYPESYS_AUDIT_SIGNING_KEY_FILE: "/run/secrets/audit_signing_key"
    });
    expect(app.depends_on).toEqual({ migrate: { condition: "service_completed_successfully" } });
    expect(compose.services.migrate!.command).toEqual(["node", "packages/host/dist/serve.js", "migrate"]);
    expect(compose.secrets.audit_signing_key!.file).toBe("./secrets/audit-1.private.pem");

    // The key is copied into a directory only this user may enter, and git-ignored with .env.
    expect(readFileSync(path.join(out, "secrets", "audit-1.private.pem"), "utf8")).toContain("BEGIN PRIVATE KEY");
    expect(statSync(path.join(out, "secrets")).mode & 0o777).toBe(0o700);
    expect(readFileSync(path.join(out, ".gitignore"), "utf8")).toBe(".env\nowner.env\nsecrets/\n");
    // Every setting it needs, and none it supplies itself (the bundled state database's URL, the key).
    const example = readFileSync(path.join(out, ".env.example"), "utf8");
    expect(example).toContain("OIDC_ISSUER=\n");
    expect(example).toContain("MCP_ALLOWED_HOSTS=localhost,fleet.example.com\n");
    expect(example).toContain("STATE_APP_PASSWORD=\n");
    expect(example).not.toContain("STATE_DB_PASSWORD");
    expect(example).not.toMatch(/^TYPESYS_STATE_URL=/m);
    expect(example).not.toMatch(/^TYPESYS_STATE_OWNER_URL=/m);
    expect(example).not.toMatch(/^TYPESYS_AUDIT_SIGNING_KEY=/m);

    // The packaged deployment builds to the same build id as the original.
    const original = await loadDeployment(shared, { packsDir: path.join(root, "packs") });
    const packaged = await loadDeployment(path.join(out, "deployment", "fleet.shared.deployment.json"), { packsDir: path.join(out, "deployment", "packs") });
    const ids = await Promise.all(
      [original, packaged].map(async (l) => {
        const h = await buildHost(l.deployment, { packs: l.packs, extensions: await loadExtensions(l.deployment), state: "memory", env: { env: (n) => (n === "OIDC_ISSUER" ? "https://idp.example" : undefined), secret: () => undefined } }).catch((e: unknown) => e);
        return h instanceof Error ? h.message : (await (async () => { const id = (h as { build: string }).build; await (h as { close(): Promise<void> }).close(); return id; })());
      })
    );
    expect(ids[0]).toMatch(/^sha256:/);
    expect(ids[1]).toBe(ids[0]);
    expect(existsSync(path.join(out, "deployment", "packs", "airforce-1.0.0.typesys-pack.json"))).toBe(true);
    expect(existsSync(path.join(out, "deployment", "packs", "core-1.0.0.typesys-pack.json"))).toBe(true);

    // It loads code the generic image does not have: said, not hidden.
    expect(r.warnings.join("\n")).toContain("It loads code the image does not have (@typesys/demo-web/airforce-extension)");
    // Written once; again only with --force.
    await expect(packageDeployment(shared, { target: "compose", packsDir: path.join(root, "packs") })).rejects.toThrow("exists: pass --force");
    await packageDeployment(shared, { target: "compose", packsDir: path.join(root, "packs"), force: true });
    // The owner's password is made once: packaging again never changes what the database was started with.
    expect(readFileSync(path.join(out, "owner.env"), "utf8")).toBe(ownerEnv);
  });

  it.skipIf(!hasCompose)("writes a project docker compose accepts", () => {
    const out = path.join(dir, "deploy-compose");
    writeFileSync(path.join(out, ".env"), readFileSync(path.join(out, ".env.example"), "utf8").replace("STATE_APP_PASSWORD=\n", "STATE_APP_PASSWORD=pw\n"));
    const config = execFileSync("docker", ["compose", "--profile", "ops", "config", "--format", "json"], { cwd: out, encoding: "utf8" });
    const parsed = JSON.parse(config) as { services: Record<string, { environment: Record<string, string> }> };
    expect(parsed.services.app!.environment.TYPESYS_STATE_URL).toBe("postgresql://typesys_app:pw@state-db:5432/typesys");
    // The owner's connection reaches migrate, never the server.
    expect(parsed.services.migrate!.environment.TYPESYS_STATE_OWNER_URL).toMatch(/^postgresql:\/\/typesys:[0-9a-f]{48}@state-db/);
    expect(parsed.services.app!.environment).not.toHaveProperty("TYPESYS_STATE_OWNER_URL");
    expect(parsed.services.app!.environment).not.toHaveProperty("POSTGRES_PASSWORD");
  });

  it("writes Kustomize-ready Kubernetes manifests: generated ConfigMap and Secrets, an init container that migrates, probes, audit CronJobs", async () => {
    const r = await packageDeployment(shared, { target: "k8s", packsDir: path.join(root, "packs"), image: "typesys:test", hosts: ["fleet.example.com"] });
    const out = r.out;
    const docs = yaml.loadAll(readFileSync(path.join(out, "typesys.yaml"), "utf8")) as { kind: string; metadata: { name: string }; spec: Record<string, unknown> }[];
    expect(docs.map((d) => d.kind)).toEqual(["Deployment", "Service", "PodDisruptionBudget", "Ingress", "PersistentVolumeClaim", "CronJob"]);
    // M8: TLS at the edge for the names given.
    expect(docs[3]!.spec).toMatchObject({ tls: [{ hosts: ["fleet.example.com"], secretName: "typesys-airforce-tls" }] });
    // The verify job: no private key, the owner's Secret nowhere but migrate, a witness volume.
    const job = ((docs[5]!.spec as { jobTemplate: { spec: { template: { spec: Record<string, unknown> } } } }).jobTemplate.spec.template.spec) as {
      containers: { args: string[]; envFrom: { secretRef?: { name: string } }[]; env: { name: string }[] }[];
      volumes: { name: string; secret?: unknown; persistentVolumeClaim?: { claimName: string } }[];
      securityContext: { fsGroup?: number };
    };
    expect(job.containers[0]!.args).toContain("--witness");
    expect(job.volumes.map((v) => v.name)).toEqual(["deployment", "audit-witness"]);
    expect(job.containers[0]!.env.map((e) => e.name)).not.toContain("TYPESYS_AUDIT_SIGNING_KEY_FILE");
    expect(job.securityContext.fsGroup).toBe(1000);
    const pod = (docs[0]!.spec as { template: { spec: Record<string, unknown> } }).template.spec as {
      initContainers: { args: string[] }[];
      containers: { readinessProbe: unknown; livenessProbe: unknown; envFrom: unknown[]; securityContext: Record<string, unknown> }[];
      volumes: { name: string; configMap?: { items: { key: string; path: string }[] }; secret?: { secretName: string } }[];
    };
    expect(pod.initContainers[0]!.args).toEqual(["node", "packages/host/dist/serve.js", "migrate"]);
    expect((pod.initContainers[0] as unknown as { envFrom: unknown[] }).envFrom).toContainEqual({ secretRef: { name: "typesys-airforce-state-owner" } });
    expect(pod.containers[0]!.envFrom).not.toContainEqual({ secretRef: { name: "typesys-airforce-state-owner" } });
    expect(pod.containers[0]!.readinessProbe).toEqual({ httpGet: { path: "/readyz", port: "http" }, periodSeconds: 10 });
    expect(pod.containers[0]!.securityContext).toMatchObject({ runAsNonRoot: true, allowPrivilegeEscalation: false });
    // The deployment keeps its file names, so its packs are where it says.
    expect(pod.volumes[0]!.configMap!.items).toEqual([
      { key: "deployment.json", path: "fleet.shared.deployment.json" },
      { key: "pack-0.json", path: "packs/core-1.0.0.typesys-pack.json" },
      { key: "pack-1.json", path: "packs/airforce-1.0.0.typesys-pack.json" }
    ]);
    // The key is a Secret of its own, mounted as a file, never imported as a variable.
    expect(pod.volumes[1]!.secret!.secretName).toBe("typesys-airforce-audit-key");
    const k = yaml.load(readFileSync(path.join(out, "kustomization.yaml"), "utf8")) as { secretGenerator: { name: string; envs?: string[]; files?: string[] }[]; configMapGenerator: { name: string }[] };
    expect(k.secretGenerator).toEqual([
      { name: "typesys-airforce-secrets", envs: ["secrets.env"] },
      { name: "typesys-airforce-state-owner", envs: ["owner.env"] },
      { name: "typesys-airforce-audit-key", files: ["key.pem=secrets/audit-1.private.pem"] }
    ]);
    expect(readFileSync(path.join(out, "secrets.env.example"), "utf8")).toMatch(/^TYPESYS_STATE_URL=$/m);
    expect(readFileSync(path.join(out, "secrets.env.example"), "utf8")).not.toMatch(/^TYPESYS_STATE_OWNER_URL=/m);
    expect(readFileSync(path.join(out, "owner.env.example"), "utf8")).toMatch(/^TYPESYS_STATE_OWNER_URL=$/m);
    expect(readFileSync(path.join(out, "config.env"), "utf8")).toContain("MCP_ALLOWED_HOSTS=localhost,typesys-airforce,fleet.example.com\n");
    expect(statSync(path.join(out, "secrets", "audit-1.private.pem")).mode & 0o777).toBe(0o600);
  });

  it("refuses what it cannot package, and says a demo is a demo", async () => {
    const err: string[] = [];
    const log: string[] = [];
    expect(await packageCommand([shared], () => undefined, (s) => err.push(s))).toBe(2);
    expect(await packageCommand([shared, "--target", "helm"], () => undefined, (s) => err.push(s))).toBe(2);
    expect(await packageCommand([shared, "--target", "k8s", "--host", "a b"], () => undefined, (s) => err.push(s))).toBe(2);
    expect(await deployCommand(["package", shared])).toBe(2);
    // A pack outside the deployment's directory cannot be mounted beside it.
    const outside = JSON.parse(readFileSync(shared, "utf8")) as { packs: { file?: string; name: string }[] };
    outside.packs = outside.packs.map((p) => (p.name === "airforce" ? { ...p, file: "../elsewhere/airforce.json" } : p));
    mkdirSync(path.join(path.dirname(dir), "elsewhere"), { recursive: true });
    writeFileSync(path.join(path.dirname(dir), "elsewhere", "airforce.json"), "{}");
    writeFileSync(path.join(dir, "outside.deployment.json"), JSON.stringify(outside));
    expect(await packageCommand([path.join(dir, "outside.deployment.json"), "--target", "k8s", "--packs-dir", path.join(root, "packs")], () => undefined, (s) => err.push(s))).toBe(1);
    expect(err.at(-1)).toContain("is outside the deployment's directory");
    rmSync(path.join(path.dirname(dir), "elsewhere"), { recursive: true, force: true });
    // The development deployment packages, with the warning first.
    expect(await packageCommand([path.join(dir, "fleet.deployment.json"), "--target", "compose", "--out", path.join(dir, "dev-out"), "--packs-dir", path.join(root, "packs")], (s) => log.push(s), (s) => err.push(s))).toBe(0);
    expect(log.join("\n")).toContain("is a demo: its fixed tokens would answer anyone who can reach the server");
  });
});

describe("a secret read from a file (ADR-0119)", () => {
  it("reads NAME, else the file NAME_FILE names, without its trailing newline, and names an unreadable file", async () => {
    const { secretFromEnvironment } = await import("../src/host.js");
    const f = path.join(dir, "key.pem");
    writeFileSync(f, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
    expect(secretFromEnvironment({ KEY: "direct", KEY_FILE: f }, "KEY")).toBe("direct");
    expect(secretFromEnvironment({ KEY_FILE: f }, "KEY")).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    expect(secretFromEnvironment({ KEY: "", KEY_FILE: f }, "KEY")).toContain("abc");
    expect(secretFromEnvironment({}, "KEY")).toBeUndefined();
    expect(() => secretFromEnvironment({ KEY_FILE: path.join(dir, "missing.pem") }, "KEY")).toThrow("KEY_FILE names");
  });
});
