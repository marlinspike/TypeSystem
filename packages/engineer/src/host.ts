import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Identity, PolicyEngine, SemanticRegistry, SemanticRuntime } from "@typesys/core";
import type { MissionHost, MissionSpec } from "./mission.js";

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

/** The host's module, resolved as the application at `fromDir` would resolve it. */
async function load(host: MissionHost, fromDir: string): Promise<Record<string, unknown>> {
  const require = createRequire(path.join(path.resolve(fromDir), "noop.js"));
  return (await import(pathToFileURL(require.resolve(host.module)).href)) as Record<string, unknown>;
}

/** Builds the mission's host and its token resolver from the module the spec names. */
export async function loadHost(spec: Pick<MissionSpec, "host">, fromDir = process.cwd()): Promise<{ host: EngineerHost; resolve: TokenResolver; workflows: ProvidedWorkflow[] }> {
  const mod = await load(spec.host, fromDir);
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
