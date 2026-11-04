import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { HostedApplication } from "@typesys/app/server";
import type { PackArchive } from "@typesys/packs";
import { DeploymentError, parseDeployment, type Deployment } from "./deployment.js";
import type { HostExtension } from "./host.js";

export interface LoadedDeployment {
  readonly deployment: Deployment;
  /** The file it was read from, absolute. */
  readonly file: string;
  readonly packs: readonly PackArchive[];
}

/** Where a pack the deployment lists is looked for, in order: its `file` relative to the deployment, else by name and version. */
export function packCandidates(dir: string, ref: Deployment["packs"][number], packsDir: string | undefined = process.env.TYPESYS_PACKS_DIR): string[] {
  const name = `${ref.name}-${ref.version}.typesys-pack.json`;
  if (ref.file) return [path.resolve(dir, ref.file)];
  if (packsDir) return [path.resolve(packsDir, name)];
  return [path.join(dir, "packs", name), path.join(dir, name), path.join(dir, "..", "packs", name)];
}

/**
 * Reads a deployment file and the pack archives it lists (ADR-0102). A pack
 * is read from its `file`, relative to the deployment, or else from
 * `<name>-<version>.typesys-pack.json` in `packsDir` (default:
 * `TYPESYS_PACKS_DIR`, else a `packs` directory beside the deployment, the
 * deployment's own directory, then a `packs` directory beside that one, as
 * this repository lays out `deployments/` and `packs/`). Nothing is
 * verified here: `buildHost` checks digests and signatures.
 */
export async function loadDeployment(file: string, opts: { packsDir?: string } = {}): Promise<LoadedDeployment> {
  const absolute = path.resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"));
  } catch (err) {
    throw new DeploymentError([`${file}: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const deployment = parseDeployment(raw);
  const dir = path.dirname(absolute);
  const problems: string[] = [];
  const packs: PackArchive[] = [];
  for (const ref of deployment.packs) {
    const candidates = packCandidates(dir, ref, opts.packsDir);
    let found: PackArchive | undefined;
    for (const c of candidates) {
      const text = await readFile(c, "utf8").catch(() => undefined);
      if (text === undefined) continue;
      try {
        found = JSON.parse(text) as PackArchive;
      } catch {
        problems.push(`${path.relative(dir, c)}: not JSON`);
      }
      break;
    }
    if (found) packs.push(found);
    else problems.push(`pack ${ref.name}@${ref.version}: not found at ${candidates.map((c) => path.relative(process.cwd(), c)).join(" or ")}`);
  }
  if (problems.length > 0) throw new DeploymentError(problems);
  return { deployment, file: absolute, packs };
}

/** A bare package specifier, optionally with a subpath: code comes from the image's own installed packages, never from a path a deployment names. */
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._/-]*)?$/;

/**
 * Imports each extension the deployment names (ADR-0102). An extension is
 * named by its package specifier (`@typesys/cold-chain/recall-extension`),
 * so its code is whatever the image installed and reviewed; a relative or
 * absolute path is refused. The module's default export is the extension,
 * or a function that returns it, and its `name` must be the specifier.
 */
export async function loadExtensions(deployment: Deployment, importer: (specifier: string) => Promise<unknown> = (s) => import(s)): Promise<HostExtension[]> {
  const problems: string[] = [];
  const out: HostExtension[] = [];
  for (const specifier of deployment.extensions ?? []) {
    if (!PACKAGE.test(specifier) || specifier.split("/").includes("..")) {
      problems.push(`extension "${specifier}": must be an installed package's specifier, not a path`);
      continue;
    }
    let mod: unknown;
    try {
      mod = await importer(specifier);
    } catch (err) {
      problems.push(`extension "${specifier}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const exported = (mod as { default?: unknown }).default;
    const ext = (typeof exported === "function" ? await (exported as () => unknown)() : exported) as HostExtension | undefined;
    if (!ext || typeof ext !== "object" || ext.name !== specifier) problems.push(`extension "${specifier}": its default export must be an extension named "${specifier}"`);
    else out.push(ext);
  }
  if (problems.length > 0) throw new DeploymentError(problems);
  return out;
}

/** A compiled application as the generic server hosts it (ADR-0108). */
export type { HostedApplication };

/**
 * Imports each application the deployment serves (ADR-0108): its `module`,
 * an installed package's specifier, or else `<name>/dist/server.js` in the
 * applications directory (`TYPESYS_APPS_DIR`, else `apps` beside the
 * deployment, else this repository's `examples/apps`). The module must
 * export `application`, named as the deployment names it.
 */
export async function loadApplications(
  deployment: Deployment,
  file: string,
  opts: { readonly appsDir?: string; readonly importer?: (specifier: string) => Promise<unknown> } = {}
): Promise<HostedApplication[]> {
  const importer = opts.importer ?? ((s: string) => import(s));
  const dir = path.dirname(path.resolve(file));
  const problems: string[] = [];
  const out: HostedApplication[] = [];
  for (const spec of deployment.applications ?? []) {
    let target: string;
    if (spec.module !== undefined) {
      if (!PACKAGE.test(spec.module) || spec.module.split("/").includes("..")) {
        problems.push(`applications["${spec.name}"].module: must be an installed package's specifier, not a path`);
        continue;
      }
      target = spec.module;
    } else {
      const appsDir = opts.appsDir ?? process.env.TYPESYS_APPS_DIR;
      const candidates = appsDir ? [path.resolve(appsDir, spec.name)] : [path.join(dir, "apps", spec.name), path.join(dir, "..", "examples", "apps", spec.name)];
      const found = await firstExisting(candidates.map((c) => path.join(c, "dist", "server.js")));
      if (!found) {
        problems.push(`application ${spec.name}: no built server at ${candidates.map((c) => path.relative(process.cwd(), path.join(c, "dist", "server.js"))).join(" or ")} (build it with typesys app build)`);
        continue;
      }
      target = pathToFileURL(found).href;
    }
    let mod: unknown;
    try {
      mod = await importer(target);
    } catch (err) {
      problems.push(`application ${spec.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const app = (mod as { application?: HostedApplication }).application;
    if (!app || typeof app !== "object" || !Array.isArray(app.flows)) problems.push(`application ${spec.name}: its module exports no \`application\` (compile it again with typesys app compile)`);
    else if (app.name !== spec.name) problems.push(`application ${spec.name}: its module is the application "${app.name}"`);
    else out.push(app);
  }
  if (problems.length > 0) throw new DeploymentError(problems);
  return out;
}

async function firstExisting(files: readonly string[]): Promise<string | undefined> {
  for (const f of files) if (await access(f).then(() => true, () => false)) return f;
  return undefined;
}
