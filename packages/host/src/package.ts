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
  readonly settings: readonly { readonly name: string; readonly secret: boolean; readonly note: string }[];
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
      for (const k of ["$secret", "$env"]) if (typeof r[k] === "string" && !out.has(r[k] as string)) out.set(r[k] as string, at);
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

/** Each Postgres or Redis URL the deployment's state names by secret, and which store. */
function stateSecrets(deployment: Deployment): { postgres: Set<string>; redis: Set<string> } {
  const postgres = new Set<string>();
  const redis = new Set<string>();
  const s = deployment.state ?? {};
  const name = (c: unknown) => (c && typeof c === "object" && "$secret" in c ? (c as { $secret: string }).$secret : undefined);
  for (const c of [s.audit?.kind === "postgres" ? s.audit.url : undefined, s.workflows?.kind === "postgres" ? s.workflows.url : undefined]) {
    const n = name(c);
    if (n) postgres.add(n);
  }
  for (const c of [s.cache?.kind === "redis" ? s.cache.url : undefined, s.rateLimit?.kind === "redis" ? s.rateLimit.url : undefined]) {
    const n = name(c);
    if (n) redis.add(n);
  }
  return { postgres, redis };
}

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
  await put(path.join(out, ".gitignore"), opts.target === "compose" ? ".env\nsecrets/\n" : "secrets.env\nsecrets/\n", true, written);
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
  const bundledRedis = bundledState && state.redis.size > 0;
  const allowedHosts = [...new Set(["localhost", ...(opts.target === "k8s" ? [name] : []), ...(opts.hosts ?? [])])].join(",");

  const settings: { name: string; secret: boolean; note: string }[] = [];
  for (const s of refs.secrets) {
    if (s === signing) continue;
    if (bundledPostgres && state.postgres.has(s)) continue;
    if (bundledRedis && state.redis.has(s)) continue;
    settings.push({
      name: s,
      secret: true,
      note: state.postgres.has(s)
        ? "Postgres connection string for the deployment's state"
        : state.redis.has(s)
          ? "Redis URL for the deployment's cache and rate limit"
          : `${usedAt.get(s) ?? "named by the deployment"}${opts.target === "compose" && /\.url$/.test(usedAt.get(s) ?? "") ? " (reached from inside the container: for a database on this machine use host.docker.internal, not localhost)" : ""}`
    });
  }
  for (const e of refs.env) settings.push({ name: e, secret: false, note: usedAt.get(e) ?? "named by the deployment" });
  settings.push({ name: "MCP_ALLOWED_HOSTS", secret: false, note: "host names clients reach the server by (ADR-0053)" });
  if (bundledPostgres) settings.push({ name: "STATE_DB_PASSWORD", secret: true, note: "password for the bundled state database" });

  const envLine = (s: { name: string; note: string }) => `# ${s.note}\n${s.name}=${s.name === "MCP_ALLOWED_HOSTS" ? allowedHosts : ""}\n`;

  if (opts.target === "compose") {
    const app: Record<string, unknown> = {
      image,
      restart: "unless-stopped",
      env_file: [".env"],
      environment: {
        TYPESYS_DEPLOYMENT: `${MOUNT}/${fileName}`,
        TYPESYS_PACKS_DIR: `${MOUNT}/packs`,
        ...(bundledPostgres ? Object.fromEntries([...state.postgres].map((s) => [s, "postgresql://typesys:${STATE_DB_PASSWORD:?set STATE_DB_PASSWORD in .env}@state-db:5432/typesys"])) : {}),
        ...(bundledRedis ? Object.fromEntries([...state.redis].map((s) => [s, "redis://state-redis:6379"])) : {}),
        ...(signing ? { [`${signing}_FILE`]: `/run/secrets/audit_signing_key` } : {})
      },
      volumes: [`./deployment:${MOUNT}:ro`],
      ...(signing && keyRel ? { secrets: ["audit_signing_key"] } : {}),
      ports: ["${TYPESYS_PORT:-3939}:3939"],
      // So a database or provider on this machine is reachable as host.docker.internal on Linux too.
      extra_hosts: ["host.docker.internal:host-gateway"],
      depends_on: { migrate: { condition: "service_completed_successfully" } }
    };
    const services: Record<string, unknown> = {
      ...(bundledPostgres
        ? {
            "state-db": {
              image: "postgres:17",
              restart: "unless-stopped",
              environment: { POSTGRES_USER: "typesys", POSTGRES_DB: "typesys", POSTGRES_PASSWORD: "${STATE_DB_PASSWORD:?set STATE_DB_PASSWORD in .env}" },
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
        env_file: [".env"],
        extra_hosts: ["host.docker.internal:host-gateway"],
        environment: app.environment,
        volumes: app.volumes,
        ...(signing && keyRel ? { secrets: ["audit_signing_key"] } : {}),
        ...(bundledPostgres || bundledRedis
          ? { depends_on: { ...(bundledPostgres ? { "state-db": { condition: "service_healthy" } } : {}), ...(bundledRedis ? { "state-redis": { condition: "service_healthy" } } : {}) } }
          : {})
      },
      app,
      // Checks the audit trail: `docker compose run --rm audit-verify`. Exits 1 on any row edited, removed or reordered.
      ...(deployment.state?.audit?.kind === "postgres"
        ? {
            "audit-verify": {
              image,
              profiles: ["ops"],
              command: ["node", "packages/cli/dist/bin.js", "audit", "verify", `${MOUNT}/${fileName}`],
              env_file: [".env"],
              environment: app.environment,
              volumes: app.volumes,
              ...(signing && keyRel ? { secrets: ["audit_signing_key"] } : {}),
              depends_on: { migrate: { condition: "service_completed_successfully" } }
            }
          }
        : {})
    };
    const compose = {
      name,
      services,
      ...(bundledPostgres ? { volumes: { "state-db": {} } } : {}),
      ...(signing && keyRel ? { secrets: { audit_signing_key: { file: `./${keyRel}` } } } : {})
    };
    await put(
      path.join(out, "compose.yaml"),
      `# Runs the TypeSystem deployment "${deployment.name}" (ADR-0119), written by typesys deploy package.\n# cp .env.example .env, fill it in, then: docker compose up -d\n${dump(compose)}`,
      force,
      written
    );
    await put(path.join(out, ".env.example"), `# Settings and secrets for "${deployment.name}". Copy to .env and fill in; .env is git-ignored.\nTYPESYS_PORT=3939\n${settings.map(envLine).join("")}`, force, written);
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
    const container = (cname: string, extra: Record<string, unknown>) => ({
      name: cname,
      image,
      envFrom: [{ configMapRef: { name: `${name}-config` } }, { secretRef: { name: `${name}-secrets` } }],
      env,
      volumeMounts: mounts,
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
            initContainers: [container("migrate", { args: ["node", "packages/host/dist/serve.js", "migrate"] })],
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
    const cron = (cname: string, schedule: string, args: string[]) => ({
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name: `${name}-${cname}`, labels },
      spec: {
        schedule,
        concurrencyPolicy: "Forbid",
        jobTemplate: { spec: { backoffLimit: 1, template: { metadata: { labels: { ...labels, "app.kubernetes.io/component": cname } }, spec: { restartPolicy: "Never", securityContext: podSecurity, containers: [container(cname, { args })], volumes } } } }
      }
    });
    const audit = deployment.state?.audit;
    const docs: unknown[] = [deploymentManifest, service, pdb];
    if (audit?.kind === "postgres") {
      // A failed run is a failed Job, which is what an operator alerts on.
      docs.push(cron("audit-verify", "17 3 * * *", ["node", "packages/cli/dist/bin.js", "audit", "verify", `${MOUNT}/${fileName}`]));
      if (audit.retainDays !== undefined) docs.push(cron("audit-prune", "47 3 * * *", ["node", "packages/cli/dist/bin.js", "audit", "prune", `${MOUNT}/${fileName}`]));
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
      secretGenerator: [{ name: `${name}-secrets`, envs: ["secrets.env"] }, ...(signing && keyRel ? [{ name: `${name}-audit-key`, files: [`key.pem=${keyRel}`] }] : [])]
    };
    await put(path.join(out, "kustomization.yaml"), `# kubectl apply -k .   (after cp secrets.env.example secrets.env and filling it in)\n${dump(kustomization)}`, force, written);
    await put(path.join(out, "config.env"), settings.filter((s) => !s.secret).map(envLine).join(""), force, written);
    await put(path.join(out, "secrets.env.example"), `# Secrets for "${deployment.name}". Copy to secrets.env and fill in; secrets.env is git-ignored.\n${settings.filter((s) => s.secret).map(envLine).join("")}`, force, written);
  }

  await put(path.join(out, "README.md"), readme(deployment, opts.target, fileName, image, settings, warnings, Boolean(signing)), force, written);
  return { out, files: written, settings, warnings };
}

function readme(deployment: Deployment, target: PackageTarget, fileName: string, image: string, settings: PackageResult["settings"], warnings: readonly string[], signed: boolean): string {
  const run =
    target === "compose"
      ? ["cp .env.example .env        # then fill it in", "docker compose up -d", "curl localhost:3939/version", "docker compose run --rm audit-verify   # check the audit trail"]
      : ["cp secrets.env.example secrets.env   # then fill it in, and edit config.env", "kubectl apply -k .", `kubectl rollout status deployment/${resourceName(deployment)}`];
  return `# ${deployment.name}, packaged for ${target === "compose" ? "Docker Compose" : "Kubernetes"}

Written by \`typesys deploy package\` (ADR-0119) from \`${fileName}\`. The server is the generic
image \`${image}\`; what it serves is \`deployment/${fileName}\` and its packs, mounted read-only,
so the build id is the one \`typesys deploy build\` printed.

\`\`\`bash
${run.join("\n")}
\`\`\`

${target === "compose" ? "The state's tables are created or updated by the `migrate` service before the server starts." : "Each pod migrates the state's tables in an init container before it serves; it is idempotent and locked, so replicas starting together are safe."}${signed ? " The audit signing key is mounted from `secrets/` as a file, never put in an environment variable." : ""}

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
        `Fill in ${target === "compose" ? ".env (from .env.example)" : "secrets.env (from secrets.env.example) and config.env"}: ${r.settings.map((s) => s.name).join(", ")}.`,
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
