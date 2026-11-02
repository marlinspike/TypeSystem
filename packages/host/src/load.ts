import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PackArchive } from "@typesys/packs";
import { DeploymentError, parseDeployment, type Deployment } from "./deployment.js";
import type { HostExtension } from "./host.js";

export interface LoadedDeployment {
  readonly deployment: Deployment;
  /** The file it was read from, absolute. */
  readonly file: string;
  readonly packs: readonly PackArchive[];
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
    const name = `${ref.name}-${ref.version}.typesys-pack.json`;
    const packsDir = opts.packsDir ?? process.env.TYPESYS_PACKS_DIR;
    const candidates = ref.file
      ? [path.resolve(dir, ref.file)]
      : packsDir
        ? [path.resolve(packsDir, name)]
        : [path.join(dir, "packs", name), path.join(dir, name), path.join(dir, "..", "packs", name)];
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
