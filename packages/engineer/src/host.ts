import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Identity, PolicyEngine, SemanticRegistry, SemanticRuntime } from "@typesys/core";
import type { EngineerDiagnostic, MissionHost, MissionSpec } from "./mission.js";

/** What a mission runs on: the governed runtime, its registry and its policy engine (a `WorkflowHost`). */
export interface EngineerHost {
  readonly runtime: SemanticRuntime;
  readonly registry: SemanticRegistry;
  readonly policyEngine: PolicyEngine;
}

/** A workflow the host already runs, as `plan` reports it. */
export interface ProvidedWorkflow {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

export type TokenResolver = (token: string | null | undefined) => Promise<Identity> | Identity;

export interface LoadHostOptions {
  /**
   * When set, a host module given as a path (relative or absolute) must be
   * inside this directory, checked before the module is imported. The MCP
   * tools set it to their root; a package name is resolved as usual.
   */
  readonly within?: string;
}

/** The host's module, resolved as the application at `fromDir` would resolve it. */
async function load(host: MissionHost, fromDir: string, options: LoadHostOptions): Promise<Record<string, unknown>> {
  const isPath = host.module.startsWith(".") || path.isAbsolute(host.module);
  // A package specifier with a `.` or `..` segment can climb out of its package when the package declares no
  // `exports` (Node then resolves the subpath as a plain path), so it is never a package name the root allows.
  if (!isPath && options.within !== undefined && host.module.split(/[\\/]/).some((seg) => seg === "." || seg === "..")) {
    throw new Error(`the host module ${host.module} climbs out of its package`);
  }
  const require = createRequire(path.join(path.resolve(fromDir), "noop.js"));
  const resolved = require.resolve(host.module);
  if (isPath && options.within !== undefined) {
    // Checked on real paths, so a symlink inside the root cannot lead to a module outside it.
    const rel = path.relative(realpathSync(path.resolve(options.within)), realpathSync(resolved));
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`the host module ${host.module} is outside the root`);
  }
  return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
}

export type LoadedHost = { host: EngineerHost; resolve: TokenResolver; workflows: ProvidedWorkflow[] };

/**
 * `loadHost`, with a failure as a diagnostic at `host/module` rather than a
 * rejected promise: a module that does not resolve, does not load, or does
 * not export what the spec names.
 */
export async function tryLoadHost(spec: Pick<MissionSpec, "host">, fromDir = process.cwd(), options: LoadHostOptions = {}): Promise<LoadedHost | { diagnostic: EngineerDiagnostic }> {
  try {
    return await loadHost(spec, fromDir, options);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    return {
      diagnostic: { code: "host-unavailable", severity: "error", at: "host/module", message: `cannot load the host: ${message}`, hint: "install the host's package, or correct host.module, host.build and host.identities" }
    };
  }
}

/** Builds the mission's host and its token resolver from the module the spec names. */
export async function loadHost(spec: Pick<MissionSpec, "host">, fromDir = process.cwd(), options: LoadHostOptions = {}): Promise<LoadedHost> {
  const mod = await load(spec.host, fromDir, options);
  const build = mod[spec.host.build];
  const resolve = mod[spec.host.identities];
  if (typeof build !== "function") throw new TypeError(`${spec.host.module} has no function "${spec.host.build}" to build the host`);
  if (typeof resolve !== "function") throw new TypeError(`${spec.host.module} has no function "${spec.host.identities}" to resolve a token`);
  const host = (await (build as (o?: unknown) => Promise<EngineerHost>)(spec.host.options)) ?? undefined;
  if (!host?.runtime || !host.registry || !host.policyEngine) throw new TypeError(`${spec.host.module}.${spec.host.build}() did not return { runtime, registry, policyEngine }`);
  const listed = spec.host.workflows === undefined ? [] : mod[spec.host.workflows];
  if (!Array.isArray(listed)) throw new TypeError(`${spec.host.module} has no list "${spec.host.workflows}" of workflow definitions`);
  const workflows = (listed as Partial<ProvidedWorkflow>[]).flatMap((w) =>
    typeof w?.name === "string" ? [{ name: w.name, version: String(w.version ?? ""), ...(typeof w.description === "string" ? { description: w.description } : {}) }] : []
  );
  return { host, resolve: resolve as TokenResolver, workflows };
}
