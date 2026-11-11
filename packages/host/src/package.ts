import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { DeploymentError, type Deployment } from "./deployment.js";
import { loadDeployment, packCandidates } from "./load.js";
import { referencesOf } from "./promote.js";

/** Where the packaged files are run (ADR-0119). */
export type PackageTarget = "compose" | "k8s";

export interface PackageOptions {
  readonly target: PackageTarget;
  /** The directory to write. Default `deploy-<target>` beside the deployment. */
  readonly out?: string;
  /** The generic server's image. Default this release's on GitHub Container Registry. */
  readonly image?: string;
  /** Host names clients reach the server by, besides the service's own: what `MCP_ALLOWED_HOSTS` lists. */
  readonly hosts?: readonly string[];
  /** Keep the state databases outside Compose: the deployment's secrets name them. Compose only. */
  readonly externalState?: boolean;
  /** Where packs without a `file` are found. Default as the server finds them. */
  readonly packsDir?: string;
  /** Replace files already written. */
  readonly force?: boolean;
}

/** The generic server's image for this version of TypeSystem. */
export function defaultImage(): string {
  const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string };
  return `ghcr.io/marlinspike/typesystem:${pkg.version}`;
}

/** What `packageDeployment` wrote. */
export interface PackageResult {
  readonly out: string;
  readonly files: readonly string[];
  /** What to put in the environment file before it runs, with a description of each. */
  readonly settings: readonly { readonly name: string; readonly secret: boolean; readonly note: string; /** Only migrate and audit prune are given it, from owner.env (ADR-0124). */ readonly owner?: boolean }[];
  readonly warnings: readonly string[];
}

const KUBE_NAME = /[^a-z0-9-]+/g;
/** A Kubernetes and Compose name for the deployment: lower case, letters, digits and dashes. */
export const resourceName = (deployment: Deployment): string => `typesys-${deployment.name.toLowerCase().replace(KUBE_NAME, "-").replace(/^-+|-+$/g, "")}`.slice(0, 50);

/** Where in the container the deployment and its packs are mounted. */
const MOUNT = "/etc/typesys";

/** Where each reference is first used in the document, as a dotted path (`sources.shop-db.url`). */
function whereUsed(deployment: Deployment): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object") {
      const r = v as Record<string, unknown>;
      for (const k of ["$secret", "$env"]) if (typeof r[k] === "string" && !out.has(r[k])) out.set(r[k], at);
      for (const k of Object.keys(r)) walk(r[k], at ? `${at}.${k}` : k);
    }
  };
  walk(deployment, "");
  return out;
}

/** The one secret the server reads as a file rather than a value: the audit signing key (multi-line PEM). */
function signingSecretOf(deployment: Deployment): string | undefined {
  const key = deployment.state?.audit?.signing?.key;
  return key && typeof key === "object" ? key.$secret : undefined;
}

/** Each Postgres or Redis URL the deployment's state names by secret, and which store; `owner`, the tables' owner's (ADR-0124). */
function stateSecrets(deployment: Deployment): { postgres: Set<string>; owner: Set<string>; redis: Set<string> } {
  const postgres = new Set<string>();
  const owner = new Set<string>();
  const redis = new Set<string>();
  const s = deployment.state ?? {};
  const name = (c: unknown) => (c && typeof c === "object" && "$secret" in c ? (c as { $secret: string }).$secret : undefined);
  for (const c of [s.audit?.kind === "postgres" ? s.audit.url : undefined, s.workflows?.kind === "postgres" ? s.workflows.url : undefined]) {
    const n = name(c);
    if (n) postgres.add(n);
  }
  for (const c of [s.audit?.kind === "postgres" ? s.audit.ownerUrl : undefined, s.workflows?.kind === "postgres" ? s.workflows.ownerUrl : undefined]) {
    const n = name(c);
    if (n) owner.add(n);
  }
  for (const c of [s.cache?.kind === "redis" ? s.cache.url : undefined, s.rateLimit?.kind === "redis" ? s.rateLimit.url : undefined]) {
    const n = name(c);
    if (n) redis.add(n);
  }
  return { postgres, owner, redis };
}

/** Where the verifier keeps its witness (ADR-0124): a volume of its own, which neither the server nor the database can write. */
const WITNESS_DIR = "/var/lib/typesys";

/** A path inside the mount for each pack, keeping a `file` the deployment names exactly, so the build id does not change. */
async function packPlacements(file: string, deployment: Deployment, packsDir: string | undefined): Promise<{ from: string; to: string }[]> {
  const dir = path.dirname(path.resolve(file));
  const out: { from: string; to: string }[] = [];
  const problems: string[] = [];
  for (const ref of deployment.packs) {
    const from = packCandidates(dir, ref, packsDir).find((c) => existsSync(c));
    if (!from) {
      problems.push(`pack ${ref.name}@${ref.version}: not found`);
      continue;
    }
    let to: string;
    if (ref.file) {
      to = path.posix.normalize(ref.file.split(path.sep).join("/"));
      if (to.startsWith("../") || path.posix.isAbsolute(to)) {
        problems.push(`pack ${ref.name}@${ref.version}: its file ${ref.file} is outside the deployment's directory; put it beside the deployment (packs/...) to package it`);
        continue;
      }
    } else to = `packs/${ref.name}-${ref.version}.typesys-pack.json`;
    out.push({ from, to });
  }
  if (problems.length > 0) throw new DeploymentError(problems);
  return out;
}

const dump = (doc: unknown): string => yaml.dump(doc, { lineWidth: 120, noRefs: true });

/** Writes a file, refusing to replace one unless `force`. */
async function put(file: string, content: string, force: boolean, written: string[], mode?: number): Promise<void> {
  if (!force && existsSync(file)) throw new DeploymentError([`${file} exists: pass --force to replace what was written before`]);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, mode !== undefined ? { mode } : {});
  written.push(file);
}

/**
 * Writes what runs a deployment (ADR-0119): the deployment and its packs as
 * they are (so the build id is the one `deploy build` printed), and either
 * a Compose project or Kustomize-ready Kubernetes manifests that run the
 * generic server's image on them, migrate its state first, probe it, and
 * name every secret and setting it needs, in an example file to fill in.
 * Nothing secret is written except a copy of the audit signing key, when
 * `typesys deploy promote` left one beside the deployment, into a
 * git-ignored directory.
 */
export async function packageDeployment(file: string, opts: PackageOptions): Promise<PackageResult> {
  const { deployment } = await loadDeployment(file, opts.packsDir ? { packsDir: opts.packsDir } : {});
  const force = opts.force ?? false;
  const out = path.resolve(opts.out ?? path.join(path.dirname(file), `deploy-${opts.target}`));
  const image = opts.image ?? defaultImage();
  const name = resourceName(deployment);
  const fileName = path.basename(file);
  const written: string[] = [];
  const warnings: string[] = [];

  if (deployment.demo) warnings.push(`${deployment.name} is a demo: its fixed tokens would answer anyone who can reach the server. Run typesys deploy promote first to share it.`);
  if (deployment.extensions?.length)
    warnings.push(`It loads code the image does not have (${deployment.extensions.join(", ")}): build an image that installs it FROM ${image}, and use that image.`);
  const apps = deployment.applications ?? [];
  if (apps.length > 0) warnings.push(`It hosts applications (${apps.map((a) => a.name).join(", ")}), served on ports of their own: publish those ports beside the server's.`);

  // The deployment and its packs, byte for byte.
  const packs = await packPlacements(file, deployment, opts.packsDir);
  const deploymentDir = path.join(out, "deployment");
  await put(path.join(deploymentDir, fileName), await readFile(file, "utf8"), force, written);
  let packBytes = 0;
  for (const p of packs) {
    const target = path.join(deploymentDir, ...p.to.split("/"));
    if (!force && existsSync(target)) throw new DeploymentError([`${target} exists: pass --force to replace what was written before`]);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(p.from, target);
    packBytes += (await stat(target)).size;
    written.push(target);
  }

  // The audit signing key, if promote made one beside the deployment: copied into a git-ignored directory.
  const signing = signingSecretOf(deployment);
  const keyId = deployment.state?.audit?.signing?.keyId;
  const keySource = keyId ? path.join(path.dirname(path.resolve(file)), "secrets", `${keyId}.private.pem`) : undefined;
  const keyRel = keyId ? `secrets/${keyId}.private.pem` : undefined;
  await put(path.join(out, ".gitignore"), opts.target === "compose" ? ".env\nowner.env\nsecrets/\n" : "secrets.env\nowner.env\nsecrets/\n", true, written);
  if (signing && keySource && keyRel) {
    const target = path.join(out, ...keyRel.split("/"));
    if (existsSync(keySource) && (force || !existsSync(target))) {
      // The directory is this user's alone; the file itself is readable, because Compose bind-mounts it into a
      // container that runs as another user (node, uid 1000), and a mount of the file does not pass through the directory.
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(target), 0o700);
      await copyFile(keySource, target);
      await chmod(target, opts.target === "compose" ? 0o644 : 0o600);
      await writeFile(path.join(out, "secrets", ".gitignore"), "*\n");
      written.push(target);
    } else if (!existsSync(target)) warnings.push(`Put the audit signing key (${signing}) in ${path.join(out, ...keyRel.split("/"))}: it was not found beside the deployment.`);
  }

  const refs = referencesOf(deployment);
  const usedAt = whereUsed(deployment);
  const state = stateSecrets(deployment);
  const bundledState = opts.target === "compose" && !opts.externalState;
  const bundledPostgres = bundledState && state.postgres.size > 0;
  // The bundled database's owner, and a role of the server's own that may only read and append (ADR-0124). A deployment
  // that names no owner signs the server in as the owner, as before, and is told so.
  const separated = state.owner.size > 0;
  if (state.postgres.size > 0 && !separated)
    warnings.push("The server signs in to its state database as the tables' owner, so its credential could lift the audit trail's append-only triggers. Name state.audit.ownerUrl (typesys deploy promote does) to give it a role of its own (ADR-0124).");
  const resource = deployment.identity?.kind === "oidc" ? deployment.identity.resource : undefined;
  if (typeof resource === "string" && resource.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(resource))
    warnings.push(`identity.resource is ${resource}: clients sign in for that origin, and send their tokens to it, in clear text. Serve it over HTTPS and make it https://.`);
  const bundledRedis = bundledState && state.redis.size > 0;
  const allowedHosts = [...new Set(["localhost", ...(opts.target === "k8s" ? [name] : []), ...(opts.hosts ?? [])])].join(",");

  const settings: { name: string; secret: boolean; note: string; owner?: boolean }[] = [];
  for (const s of refs.secrets) {
    if (s === signing) continue;
    if (bundledPostgres && (state.postgres.has(s) || state.owner.has(s))) continue;
    if (bundledRedis && state.redis.has(s)) continue;
    settings.push({
      name: s,
      secret: true,
      ...(state.owner.has(s) ? { owner: true } : {}),
      note: state.owner.has(s)
        ? "Postgres connection string for the role that owns the state's tables: given only to migrate and audit prune, never the server"
        : state.postgres.has(s)
        ? `Postgres connection string the server signs in with${separated ? ": a role that does not own the tables (migrate creates it and grants it read and append)" : ""}`
        : state.redis.has(s)
          ? "Redis URL for the deployment's cache and rate limit"
          : `${usedAt.get(s) ?? "named by the deployment"}${opts.target === "compose" && /\.url$/.test(usedAt.get(s) ?? "") ? " (reached from inside the container: for a database on this machine use host.docker.internal, not localhost)" : ""}`
    });
  }
  for (const e of refs.env) settings.push({ name: e, secret: false, note: usedAt.get(e) ?? "named by the deployment" });
  settings.push({ name: "MCP_ALLOWED_HOSTS", secret: false, note: "host names clients reach the server by (ADR-0053)" });
  if (bundledPostgres && !separated) settings.push({ name: "STATE_DB_PASSWORD", secret: true, note: "password for the bundled state database" });
  if (bundledPostgres && separated) settings.push({ name: "STATE_APP_PASSWORD", secret: true, note: "password for the server's own role in the bundled state database (typesys_app: read and append only)" });
  /** A setting only migrate and audit prune are given. */
  const ownerOnly = (n: string) => state.owner.has(n);

  const envLine = (s: { name: string; note: string }) => `# ${s.note}\n${s.name}=${s.name === "MCP_ALLOWED_HOSTS" ? allowedHosts : ""}\n`;

  if (opts.target === "compose") {
    const app: Record<string, unknown> = {
      image,
      restart: "unless-stopped",
      env_file: [".env"],
      environment: {
        TYPESYS_DEPLOYMENT: `${MOUNT}/${fileName}`,
        TYPESYS_PACKS_DIR: `${MOUNT}/packs`,
        ...(bundledPostgres
          ? Object.fromEntries(
              [...state.postgres].map((s) => [
                s,
                separated ? "postgresql://typesys_app:${STATE_APP_PASSWORD:?set STATE_APP_PASSWORD in .env}@state-db:5432/typesys" : "postgresql://typesys:${STATE_DB_PASSWORD:?set STATE_DB_PASSWORD in .env}@state-db:5432/typesys"
              ])
            )
          : {}),
        ...(bundledRedis ? Object.fromEntries([...state.redis].map((s) => [s, "redis://state-redis:6379"])) : {}),
        ...(signing ? { [`${signing}_FILE`]: `/run/secrets/audit_signing_key` } : {})
      },
      volumes: [`./deployment:${MOUNT}:ro`],
      ...(signing && keyRel ? { secrets: ["audit_signing_key"] } : {}),
      // This machine only, by default: put a TLS-terminating proxy in front (README), or set TYPESYS_BIND to publish wider.
      ports: ["${TYPESYS_BIND:-127.0.0.1}:${TYPESYS_PORT:-3939}:3939"],
      // So a database or provider on this machine is reachable as host.docker.internal on Linux too.
      extra_hosts: ["host.docker.internal:host-gateway"],
      depends_on: { migrate: { condition: "service_completed_successfully" } }
    };
    const verifyEnvironment = Object.fromEntries(Object.entries(app.environment as Record<string, string>).filter(([k]) => !(signing && k === `${signing}_FILE`)));
    const services: Record<string, unknown> = {
      ...(bundledPostgres
        ? {
            "state-db": {
              image: "postgres:17",
              restart: "unless-stopped",
              ...(separated
                ? { env_file: ["owner.env"], environment: { POSTGRES_USER: "typesys", POSTGRES_DB: "typesys" } }
                : { environment: { POSTGRES_USER: "typesys", POSTGRES_DB: "typesys", POSTGRES_PASSWORD: "${STATE_DB_PASSWORD:?set STATE_DB_PASSWORD in .env}" } }),
              volumes: ["state-db:/var/lib/postgresql/data"],
              healthcheck: { test: ["CMD-SHELL", "pg_isready -U typesys"], interval: "5s", timeout: "5s", retries: 20 }
            }
          }
        : {}),
      ...(bundledRedis ? { "state-redis": { image: "redis:8", restart: "unless-stopped", healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: "5s", timeout: "5s", retries: 20 } } } : {}),
      // Creates or updates the state's tables before the server starts (ADR-0117): idempotent, so it runs on every `up`.
      migrate: {
        image,
        command: ["node", "packages/host/dist/serve.js", "migrate"],
        // The owner's connection string is in owner.env, which only migrate and audit-prune read.
        env_file: separated ? [".env", "owner.env"] : [".env"],
        extra_hosts: ["host.docker.internal:host-gateway"],
        environment: app.environment,
        volumes: app.volumes,
        ...(signing && keyRel ? { secrets: ["audit_signing_key"] } : {}),
        ...(bundledPostgres || bundledRedis
          ? { depends_on: { ...(bundledPostgres ? { "state-db": { condition: "service_healthy" } } : {}), ...(bundledRedis ? { "state-redis": { condition: "service_healthy" } } : {}) } }
          : {})
      },
      app,
      // Checks the audit trail: `docker compose --profile ops run --rm audit-verify`. Exits 1 on any row edited, removed or
      // reordered, or any chain, checkpoint or row the last run saw that is gone. Verifying needs only the public keys in the
      // deployment, so it is given no private key; its witness lives in a volume of its own (ADR-0124).
      ...(deployment.state?.audit?.kind === "postgres"
        ? {
            "audit-verify": {
              image,
              profiles: ["ops"],
              command: ["node", "packages/cli/dist/bin.js", "audit", "verify", `${MOUNT}/${fileName}`, "--witness", `${WITNESS_DIR}/audit-witness.json`],
              env_file: [".env"],
              environment: verifyEnvironment,
              volumes: [...(app.volumes as string[]), `audit-witness:${WITNESS_DIR}`],
              depends_on: { migrate: { condition: "service_completed_successfully" } }
            },
            ...(deployment.state.audit.retainDays !== undefined
              ? {
                  "audit-prune": {
                    image,
                    profiles: ["ops"],
                    command: ["node", "packages/cli/dist/bin.js", "audit", "prune", `${MOUNT}/${fileName}`],
                    env_file: separated ? [".env", "owner.env"] : [".env"],
                    environment: app.environment,
                    volumes: app.volumes,
                    ...(signing && keyRel ? { secrets: ["audit_signing_key"] } : {}),
                    depends_on: { migrate: { condition: "service_completed_successfully" } }
                  }
                }
              : {})
          }
        : {})
    };
    const compose = {
      name,
      services,
      ...(bundledPostgres || deployment.state?.audit?.kind === "postgres"
        ? { volumes: { ...(bundledPostgres ? { "state-db": {} } : {}), ...(deployment.state?.audit?.kind === "postgres" ? { "audit-witness": {} } : {}) } }
        : {}),
      ...(signing && keyRel ? { secrets: { audit_signing_key: { file: `./${keyRel}` } } } : {})
    };
    await put(
      path.join(out, "compose.yaml"),
      `# Runs the TypeSystem deployment "${deployment.name}" (ADR-0119), written by typesys deploy package.\n# cp .env.example .env, fill it in, then: docker compose up -d\n${dump(compose)}`,
      force,
      written
    );
    await put(
      path.join(out, ".env.example"),
      `# Settings and secrets for "${deployment.name}". Copy to .env and fill in; .env is git-ignored.\n# Published on this machine only: put a TLS-terminating proxy in front, or set TYPESYS_BIND=0.0.0.0 behind one.\nTYPESYS_BIND=127.0.0.1\nTYPESYS_PORT=3939\n${settings.filter((x) => !ownerOnly(x.name)).map(envLine).join("")}`,
      force,
      written
    );
    if (separated) await ownerEnv(out, bundledPostgres ? [...state.owner] : [], settings.filter((x) => ownerOnly(x.name)), envLine, force, written);
  } else {
    const labels = { "app.kubernetes.io/name": "typesys", "app.kubernetes.io/instance": name };
    const files = [
      { key: "deployment.json", path: fileName, source: `deployment/${fileName}` },
      ...packs.map((p, i) => ({ key: `pack-${i}.json`, path: p.to, source: `deployment/${p.to}` }))
    ];
    if (packBytes > 900_000) warnings.push(`Its packs are ${Math.round(packBytes / 1024)} KiB: a ConfigMap holds at most 1 MiB. Bake them into an image FROM ${image} instead.`);
    const env = [
      { name: "TYPESYS_DEPLOYMENT", value: `${MOUNT}/${fileName}` },
      { name: "TYPESYS_PACKS_DIR", value: `${MOUNT}/packs` },
      ...(signing ? [{ name: `${signing}_FILE`, value: "/var/run/typesys/audit-signing-key" }] : [])
    ];
    const volumes = [
      { name: "deployment", configMap: { name: `${name}-deployment`, items: files.map((f) => ({ key: f.key, path: f.path })) } },
      // A Secret of its own, so the key is only ever a file: envFrom imports every key of the other Secret as a variable.
      ...(signing ? [{ name: "audit-signing-key", secret: { secretName: `${name}-audit-key`, items: [{ key: "key.pem", path: "audit-signing-key" }] } }] : [])
    ];
    const mounts = [{ name: "deployment", mountPath: MOUNT, readOnly: true }, ...(signing ? [{ name: "audit-signing-key", mountPath: "/var/run/typesys", readOnly: true }] : [])];
    // Only migrate and audit prune are given the owner's Secret; the verifier is given no private key (ADR-0124).
    const container = (cname: string, extra: Record<string, unknown>, opt: { owner?: boolean; key?: boolean; witness?: boolean } = {}) => ({
      name: cname,
      image,
      envFrom: [{ configMapRef: { name: `${name}-config` } }, { secretRef: { name: `${name}-secrets` } }, ...(opt.owner && separated ? [{ secretRef: { name: `${name}-state-owner` } }] : [])],
      env: opt.key === false ? env.filter((e) => e.name !== `${signing}_FILE`) : env,
      volumeMounts: [...(opt.key === false ? mounts.filter((m) => m.name !== "audit-signing-key") : mounts), ...(opt.witness ? [{ name: "audit-witness", mountPath: WITNESS_DIR }] : [])],
      securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
      ...extra
    });
    const podSecurity = { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: "RuntimeDefault" } };
    const deploymentManifest = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, labels },
      spec: {
        replicas: 2,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            securityContext: podSecurity,
            // Every pod migrates before it serves (ADR-0117): idempotent and advisory-locked, so replicas starting together are safe.
            initContainers: [container("migrate", { args: ["node", "packages/host/dist/serve.js", "migrate"] }, { owner: true })],
            containers: [
              container("server", {
                ports: [{ name: "http", containerPort: 3939 }],
                readinessProbe: { httpGet: { path: "/readyz", port: "http" }, periodSeconds: 10 },
                livenessProbe: { httpGet: { path: "/healthz", port: "http" }, initialDelaySeconds: 10, periodSeconds: 15 },
                resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { memory: "1Gi" } }
              })
            ],
            volumes
          }
        }
      }
    };
    const service = { apiVersion: "v1", kind: "Service", metadata: { name, labels }, spec: { selector: labels, ports: [{ name: "http", port: 80, targetPort: "http" }] } };
    const pdb = { apiVersion: "policy/v1", kind: "PodDisruptionBudget", metadata: { name, labels }, spec: { minAvailable: 1, selector: { matchLabels: labels } } };
    const cron = (cname: string, schedule: string, args: string[], opt: { owner?: boolean; key?: boolean; witness?: boolean }) => ({
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name: `${name}-${cname}`, labels },
      spec: {
        schedule,
        concurrencyPolicy: "Forbid",
        jobTemplate: {
          spec: {
            backoffLimit: 1,
            template: {
              metadata: { labels: { ...labels, "app.kubernetes.io/component": cname } },
              spec: {
                restartPolicy: "Never",
                // fsGroup: the witness volume is writable by the image's unprivileged user.
                securityContext: opt.witness ? { ...podSecurity, fsGroup: 1000 } : podSecurity,
                containers: [container(cname, { args }, opt)],
                volumes: [
                  ...(opt.key === false ? volumes.filter((v) => v.name !== "audit-signing-key") : volumes),
                  ...(opt.witness ? [{ name: "audit-witness", persistentVolumeClaim: { claimName: `${name}-audit-witness` } }] : [])
                ]
              }
            }
          }
        }
      }
    });
    const audit = deployment.state?.audit;
    const docs: unknown[] = [deploymentManifest, service, pdb];
    // TLS at the edge (ADR-0124): with --host, an Ingress for those names, its certificate in a Secret to provide (or
    // that cert-manager fills, given its annotation). Bearer tokens never cross the network in clear text.
    const hosts = (opts.hosts ?? []).filter((h) => h !== "localhost");
    if (hosts.length > 0)
      docs.push({
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: { name, labels },
        spec: {
          tls: [{ hosts, secretName: `${name}-tls` }],
          rules: hosts.map((host) => ({ host, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name, port: { name: "http" } } } }] } }))
        }
      });
    if (audit?.kind === "postgres") {
      // The witness outlives each run, in a volume only the verifier mounts.
      docs.push({ apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: `${name}-audit-witness`, labels }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "64Mi" } } } });
      // A failed run is a failed Job, which is what an operator alerts on.
      docs.push(cron("audit-verify", "17 3 * * *", ["node", "packages/cli/dist/bin.js", "audit", "verify", `${MOUNT}/${fileName}`, "--witness", `${WITNESS_DIR}/audit-witness.json`], { key: false, witness: true }));
      if (audit.retainDays !== undefined) docs.push(cron("audit-prune", "47 3 * * *", ["node", "packages/cli/dist/bin.js", "audit", "prune", `${MOUNT}/${fileName}`], { owner: true }));
    }
    await put(path.join(out, "typesys.yaml"), `# The TypeSystem deployment "${deployment.name}" (ADR-0119), written by typesys deploy package.\n${docs.map(dump).join("---\n")}`, force, written);
    const kustomization = {
      apiVersion: "kustomize.config.k8s.io/v1beta1",
      kind: "Kustomization",
      resources: ["typesys.yaml"],
      // Generated with a content hash in their names: changing the deployment file or a secret rolls the pods.
      configMapGenerator: [
        { name: `${name}-deployment`, files: files.map((f) => `${f.key}=${f.source}`) },
        { name: `${name}-config`, envs: ["config.env"] }
      ],
      secretGenerator: [
        { name: `${name}-secrets`, envs: ["secrets.env"] },
        ...(separated ? [{ name: `${name}-state-owner`, envs: ["owner.env"] }] : []),
        ...(signing && keyRel ? [{ name: `${name}-audit-key`, files: [`key.pem=${keyRel}`] }] : [])
      ]
    };
    await put(path.join(out, "kustomization.yaml"), `# kubectl apply -k .   (after cp secrets.env.example secrets.env and filling it in)\n${dump(kustomization)}`, force, written);
    await put(path.join(out, "config.env"), settings.filter((s) => !s.secret).map(envLine).join(""), force, written);
    await put(path.join(out, "secrets.env.example"), `# Secrets for "${deployment.name}". Copy to secrets.env and fill in; secrets.env is git-ignored.\n${settings.filter((s) => s.secret && !ownerOnly(s.name)).map(envLine).join("")}`, force, written);
    if (separated) await ownerEnv(out, [], settings.filter((x) => ownerOnly(x.name)), envLine, force, written);
  }

  await put(path.join(out, "README.md"), readme(deployment, opts.target, fileName, image, settings, warnings, Boolean(signing), { separated, bundled: bundledPostgres, hosts: (opts.hosts ?? []).filter((h) => h !== "localhost") }), force, written);
  return { out, files: written, settings, warnings };
}

/**
 * The owner's settings, apart from everything the server reads (ADR-0124):
 * `owner.env.example` to fill in, or, for a bundled database, `owner.env`
 * itself with a password made here, once (never replaced: the database keeps
 * the password it was first started with).
 */
async function ownerEnv(out: string, bundled: readonly string[], settings: PackageResult["settings"], envLine: (s: { name: string; note: string }) => string, force: boolean, written: string[]): Promise<void> {
  if (bundled.length > 0) {
    const file = path.join(out, "owner.env");
    if (existsSync(file)) return;
    const pw = randomBytes(24).toString("hex");
    await writeFile(
      file,
      `# The bundled state database's owner (ADR-0124): read by state-db, migrate and audit-prune only, never the server. Git-ignored.\nPOSTGRES_PASSWORD=${pw}\n${bundled.map((n) => `${n}=postgresql://typesys:${pw}@state-db:5432/typesys\n`).join("")}`,
      { mode: 0o600 }
    );
    written.push(file);
    return;
  }
  await put(path.join(out, "owner.env.example"), `# The state tables' owner (ADR-0124): only migrate and audit prune are given these, never the server.\n# Copy to owner.env and fill in; owner.env is git-ignored.\n${settings.map(envLine).join("")}`, force, written);
}

function readme(
  deployment: Deployment,
  target: PackageTarget,
  fileName: string,
  image: string,
  settings: PackageResult["settings"],
  warnings: readonly string[],
  signed: boolean,
  roles: { readonly separated: boolean; readonly bundled: boolean; readonly hosts: readonly string[] }
): string {
  const ownerStep = roles.separated && !roles.bundled ? [`cp owner.env.example owner.env   # the tables' owner: migrate${target === "compose" ? " and audit-prune" : " and the prune job"} only`] : [];
  const audited = deployment.state?.audit?.kind === "postgres";
  const run =
    target === "compose"
      ? ["cp .env.example .env        # then fill it in", ...ownerStep, "docker compose up -d", "curl localhost:3939/version", ...(audited ? ["docker compose --profile ops run --rm audit-verify   # check the audit trail"] : [])]
      : ["cp secrets.env.example secrets.env   # then fill it in, and edit config.env", ...ownerStep, "kubectl apply -k .", `kubectl rollout status deployment/${resourceName(deployment)}`];
  const tls =
    target === "compose"
      ? "The server is published on this machine only (`TYPESYS_BIND=127.0.0.1`). Clients send bearer tokens with every request, so put a reverse proxy that terminates TLS (Caddy, nginx, a cloud load balancer) in front of it, set `identity.resource` to its `https://` origin, and add its host name to `MCP_ALLOWED_HOSTS`. Set `TYPESYS_BIND=0.0.0.0` only when that proxy runs on another machine on a private network."
      : roles.hosts.length > 0
        ? `\`typesys.yaml\` has an Ingress for ${roles.hosts.join(", ")} that serves TLS with the certificate in the Secret \`${resourceName(deployment)}-tls\`: create it (\`kubectl create secret tls ...\`), or let cert-manager fill it by annotating the Ingress with your issuer. Set \`identity.resource\` to \`https://${roles.hosts[0]}\`.`
        : "The Service is cluster-internal. Clients send bearer tokens with every request, so expose it only through an Ingress or gateway that terminates TLS (package again with `--host <name>` to have one written), and set `identity.resource` to that `https://` origin.";
  const owner = !audited
    ? ""
    : roles.separated
      ? `\n\nThe server signs in to its state database as a role that may read and append, not as the tables' owner (ADR-0124): ${roles.bundled ? "`typesys_app`, created by `migrate` with `STATE_APP_PASSWORD`. The owner's password was made for you in `owner.env`, which only the database, `migrate` and `audit-prune` read." : "`migrate` signs in as the owner from `owner.env` and grants the server's role what it needs."} The audit verifier is given no private key, and keeps a witness of each chain in a volume of its own, so a chain deleted whole, checkpoints and all, is still caught.`
      : "\n\nThe server signs in to its state database as the tables' owner. Name `state.audit.ownerUrl` in the deployment (`typesys deploy promote` does) and package again, so the server gets a role that cannot lift the audit trail's triggers (ADR-0124).";

  return `# ${deployment.name}, packaged for ${target === "compose" ? "Docker Compose" : "Kubernetes"}

Written by \`typesys deploy package\` (ADR-0119) from \`${fileName}\`. The server is the generic
image \`${image}\`; what it serves is \`deployment/${fileName}\` and its packs, mounted read-only,
so the build id is the one \`typesys deploy build\` printed.

\`\`\`bash
${run.join("\n")}
\`\`\`

${target === "compose" ? "The state's tables are created or updated by the `migrate` service before the server starts." : "Each pod migrates the state's tables in an init container before it serves; it is idempotent and locked, so replicas starting together are safe."}${signed ? " The audit signing key is mounted from `secrets/` as a file, never put in an environment variable." : ""}${owner}

## TLS

${tls}

## What to provide

| Setting | Secret | What it is |
|---|---|---|
${settings.map((s) => `| \`${s.name}\` | ${s.secret ? "yes" : "no"} | ${s.note} |`).join("\n")}

${warnings.length ? `## Before it runs\n\n${warnings.map((w) => `- ${w}`).join("\n")}\n\n` : ""}## Upgrading

Change the deployment beside the original, check it, and package it again:

\`\`\`bash
npx typesys deploy check ${fileName} next.${fileName}
npx typesys deploy package next.${fileName} --target ${target} --force
${target === "compose" ? "docker compose up -d" : "kubectl apply -k ."}
\`\`\`

${target === "k8s" ? "The ConfigMap and Secret are generated with a hash of their contents in their names, so applying a changed deployment or secret rolls the pods.\n" : ""}
See docs/how-to/deploy-with-containers.md and docs/how-to/operate-a-deployment.md.
`;
}

export const PACKAGE_USAGE = `  typesys deploy package <deployment.json> --target compose|k8s [--out <dir>] [--image <ref>]
                         [--host <name>]... [--external-state] [--packs-dir <dir>] [--force]
      Write what runs the deployment (ADR-0119): the deployment and its packs as they are, and a
      Compose project (with a state database unless --external-state) or Kustomize-ready
      Kubernetes manifests (probes, an init container that migrates, a disruption budget, audit
      CronJobs), plus an example file naming every secret and setting to fill in. --host adds a
      name clients reach it by to MCP_ALLOWED_HOSTS.
`;

/** `typesys deploy package ...`: the exit code. */
export async function packageCommand(argv: readonly string[], log: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  let file: string | undefined;
  let target: string | undefined;
  const hosts: string[] = [];
  const o: { out?: string; image?: string; packsDir?: string; force: boolean; externalState: boolean } = { force: false, externalState: false };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      const next = () => {
        const v = argv[++i];
        if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
        return v;
      };
      if (a === "--target") target = next();
      else if (a === "--out") o.out = next();
      else if (a === "--image") o.image = next();
      else if (a === "--host") hosts.push(next());
      else if (a === "--packs-dir") o.packsDir = next();
      else if (a === "--force") o.force = true;
      else if (a === "--external-state") o.externalState = true;
      else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
      else if (file === undefined) file = a;
      else throw new Error(`Unexpected argument ${a}`);
    }
  } catch (e) {
    err(`${(e as Error).message}\n\n${PACKAGE_USAGE}`);
    return 2;
  }
  if (!file || (target !== "compose" && target !== "k8s")) {
    err(`typesys deploy package needs a deployment and --target compose or --target k8s\n\n${PACKAGE_USAGE}`);
    return 2;
  }
  const badHost = hosts.find((h) => !/^[A-Za-z0-9.-]+$/.test(h));
  if (badHost !== undefined) {
    err(`--host takes a host name such as typesys.example.com, not ${JSON.stringify(badHost)}`);
    return 2;
  }
  try {
    const r = await packageDeployment(file, { target, hosts, ...o });
    const rel = (f: string) => path.relative(process.cwd(), f) || ".";
    log(
      [
        `Wrote ${rel(r.out)}/ for ${target === "compose" ? "Docker Compose" : "Kubernetes"}: ${r.files.length} files.`,
        ...(r.warnings.length ? ["", ...r.warnings.map((w) => `! ${w}`)] : []),
        "",
        `Fill in ${target === "compose" ? ".env (from .env.example)" : "secrets.env (from secrets.env.example) and config.env"}: ${r.settings.filter((s) => !s.owner).map((s) => s.name).join(", ")}.`,
        ...(r.settings.some((s) => s.owner) ? [`Fill in owner.env (from owner.env.example), which only migrate and audit prune read: ${r.settings.filter((s) => s.owner).map((s) => s.name).join(", ")}.`] : []),
        `Then: ${target === "compose" ? `cd ${rel(r.out)} && docker compose up -d` : `kubectl apply -k ${rel(r.out)}`}`
      ].join("\n")
    );
    return 0;
  } catch (e) {
    const problems = e instanceof DeploymentError ? e.problems : [(e as Error).message];
    err(`FAIL\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }
}
