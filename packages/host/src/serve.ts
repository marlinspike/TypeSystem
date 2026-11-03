#!/usr/bin/env node
/**
 * The generic TypeSystem server (ADR-0102): one image for every deployment.
 * It reads a deployment file, builds the governed runtime from it, and
 * serves MCP over Streamable HTTP at `/mcp` and the governed REST API under
 * `/api`, both from that one runtime.
 *
 *   typesys-host deployment.json            serve (PORT, default 3939)
 *   typesys-host deployment.json --check    build it, print the build id, exit
 *
 * The deployment file is `argv[2]` or `TYPESYS_DEPLOYMENT`. Credentials and
 * service addresses come from the environment, as the deployment's `$secret`
 * and `$env` references name them. `MCP_ALLOWED_HOSTS` lists the host names
 * the server answers to (ADR-0053); `TYPESYS_AGENT_MODEL` names the model
 * behind the agents it answers (ADR-0075).
 */
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { AdapterUnavailableError, contractMismatches } from "@typesys/core";
import { applicationApp, type HostedApplication } from "@typesys/app/server";
import { createApiApp } from "@typesys/http";
import { agentAudienceFromEnvironment } from "@typesys/llm";
import { createHttpApp } from "@typesys/mcp-server";
import { WorkflowEngine, type AiModel } from "@typesys/workflow";
import { DeploymentError, type ConfigString } from "./deployment.js";
import { buildHost, processEnvironment, type Host, type HostEnvironment } from "./host.js";
import { loadApplications, loadDeployment, loadExtensions } from "./load.js";

export interface ServeOptions {
  readonly file: string;
  readonly port?: number;
  /** The address to listen on: default every interface (a container's server); `typesys dev` passes 127.0.0.1. */
  readonly listenHost?: string;
  readonly allowedHosts?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where references resolve; default the process environment. */
  readonly hostEnv?: HostEnvironment;
  /** Where applications are found when the deployment names no module. */
  readonly appsDir?: string;
  /** Where packs are found when the deployment names no file (default `TYPESYS_PACKS_DIR`, then beside the deployment). */
  readonly packsDir?: string;
}

/** Loads and builds the host a deployment file describes. */
export async function hostFromFile(file: string, env?: HostEnvironment): Promise<Host> {
  const { deployment, packs } = await loadDeployment(file);
  const extensions = await loadExtensions(deployment);
  return buildHost(deployment, { packs, extensions, ...(env ? { env } : {}) });
}

function portOf(value: ConfigString, env: HostEnvironment, at: string): number {
  const raw = typeof value === "string" ? value : (env.env(value.$env) ?? value.default);
  const port = Number(raw);
  if (raw === undefined || !Number.isInteger(port) || port < 0 || port > 65535) throw new DeploymentError([`${at}: ${raw === undefined ? "is not set" : `${raw} is not a port`}`]);
  return port;
}

function listen(app: { listen(port: number, host: string, cb: () => void): Server; listen(port: number, cb: () => void): Server }, port: number, host?: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const ready = () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : port });
    };
    const server = host === undefined ? app.listen(port, ready) : app.listen(port, host, ready);
    server.once("error", reject);
  });
}

/**
 * The deployment's one workflow engine (ADR-0108): every hosted
 * application's flows on the deployment's journal (ADR-0106), with the
 * models their AI steps name. Each application's contract must be kept by
 * this build, as a declared consumer's is (ADR-0103).
 */
export async function hostedWorkflows(host: Host, apps: readonly HostedApplication[]): Promise<WorkflowEngine> {
  const served = new Map((await host.registry.listTypes()).map((t) => [t.name, t.version]));
  const problems = apps.flatMap((a) =>
    a.contract === undefined
      ? [`application ${a.name} declares no contract: compile it with typesys app compile, which writes one`]
      : contractMismatches(a.contract, served).map((m) => `application ${a.name} needs ${m.type} ${m.range}, ${m.version ? `this build has ${m.version}` : "this build has no such Type"}`)
  );
  const models: Record<string, AiModel> = {};
  const owner: Record<string, string> = {};
  for (const a of apps) {
    for (const [role, model] of Object.entries((await a.models?.()) ?? {})) {
      if (Object.hasOwn(models, role)) problems.push(`application ${a.name} names model "${role}", which ${owner[role]} also names`);
      models[role] = model;
      owner[role] = a.name;
    }
  }
  if (problems.length > 0) throw new DeploymentError(problems);
  const engine = await WorkflowEngine.create({ host, journal: host.state.journal, models });
  for (const a of apps) for (const flow of a.flows) engine.register(flow);
  return engine;
}

export interface Serving {
  readonly host: Host;
  readonly port: number;
  readonly workflows: WorkflowEngine;
  /** Each hosted application's port, by name. */
  readonly applications: Readonly<Record<string, number>>;
  close(): Promise<void>;
}

/** Builds the host and serves it, and every application it hosts; resolves once all are listening. */
export async function serve(opts: ServeOptions): Promise<Serving> {
  const env = opts.hostEnv ?? processEnvironment;
  const { deployment, packs } = await loadDeployment(opts.file, opts.packsDir ? { packsDir: opts.packsDir } : {});
  const extensions = await loadExtensions(deployment);
  const host = await buildHost(deployment, { packs, extensions, env });
  // A declared table or column the database does not have would fail every read of its Type: refuse to start instead (ADR-0110).
  // A database that cannot be reached yet is not that: /readyz reports it until it can.
  try {
    const problems = await host.checkSources();
    if (problems.length > 0) throw new DeploymentError(problems);
  } catch (err) {
    if (!(err instanceof AdapterUnavailableError)) {
      await host.close();
      throw err;
    }
    console.warn(`Not checked against its database yet: ${err.message}`);
  }
  const servers: Server[] = [];
  const closeAll = async () => {
    // Open MCP and SSE streams would hold close() forever, and with it the last signed checkpoint: end them too.
    await Promise.allSettled(
      servers.map(
        (s) =>
          new Promise<void>((r) => {
            s.close(() => r());
            s.closeAllConnections();
          })
      )
    );
    await host.close();
  };
  try {
    const apps = await loadApplications(deployment, opts.file, { ...(opts.appsDir ? { appsDir: opts.appsDir } : {}) });
    const workflows = await hostedWorkflows(host, apps);
    const audience = await agentAudienceFromEnvironment(opts.env ?? process.env);
    const allowedHosts = opts.allowedHosts?.length ? opts.allowedHosts : undefined;
    const app = createHttpApp({
      backend: host,
      identityResolver: host.identityResolver,
      serverInfo: { name: host.deployment.name, version: host.build },
      ready: () => host.state.ready(),
      ...(audience ? { audience } : {}),
      ...(allowedHosts ? { allowedHosts } : {})
    });
    // Which build is serving, and where it keeps what outlives a request: what an operator checks after rolling a new image or deployment file (ADR-0101, ADR-0106).
    app.get("/version", (_req, res) =>
      void res.json({
        deployment: host.deployment.name,
        build: host.build,
        packs: host.packs.map((p) => `${p.name}@${p.version}`),
        state: host.state.kinds,
        auditChain: host.state.audit.chain,
        applications: apps.map((a) => a.name)
      })
    );
    // Where to start, for a person or an agent that opens the server's address (ADR-0112). What /version says, and where things are.
    app.get("/", (_req, res) =>
      void res.json({
        deployment: host.deployment.name,
        build: host.build,
        mcp: "/mcp",
        api: "/api",
        openapi: "/api/openapi.json",
        version: "/version",
        health: { live: "/healthz", ready: "/readyz" },
        authentication: host.deployment.identity.kind === "oidc" ? "Authorization: Bearer <a token from the deployment's identity provider>" : "Authorization: Bearer <a token the deployment names>"
      })
    );
    const personas = Object.values(host.personas);
    app.use(
      createApiApp({
        backend: host,
        identityResolver: host.identityResolver,
        workflows,
        subjects: {
          list: async () => personas.map((p) => ({ subjectId: p.subjectId })),
          resolve: async (subjectId) => personas.find((p) => p.subjectId === subjectId)
        },
        ...(allowedHosts ? { allowedHosts } : {})
      })
    );
    const main = await listen(app, opts.port ?? 3939, opts.listenHost);
    servers.push(main.server);
    const ports: Record<string, number> = {};
    for (const a of apps) {
      const spec = deployment.applications!.find((s) => s.name === a.name)!;
      const port = portOf(spec.port, env, `applications["${a.name}"].port`);
      const served = await listen(
        applicationApp({
          backend: host,
          identities: (token) => host.identityResolver(token ?? undefined),
          workflows,
          ...(a.title ? { title: a.title } : {}),
          ...(a.contract ? { contract: a.contract } : {}),
          ...(a.clientDir ? { clientDir: a.clientDir } : {})
        }),
        port,
        opts.listenHost
      );
      servers.push(served.server);
      ports[a.name] = served.port;
    }
    return { host, port: main.port, workflows, applications: ports, close: closeAll };
  } catch (err) {
    await closeAll();
    throw err;
  }
}

/** Runs the server from the command line; the `typesys-host` command calls it. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--")) ?? process.env.TYPESYS_DEPLOYMENT;
  if (!file) {
    console.error("Usage: typesys-host <deployment.json> [--check]   (or set TYPESYS_DEPLOYMENT)");
    process.exitCode = 2;
    return;
  }
  try {
    if (args.includes("--check")) {
      const host = await hostFromFile(file);
      console.log(`${host.deployment.name} builds: ${host.build}`);
      console.log(`state: audit ${host.state.kinds.audit}, workflows ${host.state.kinds.workflows}, cache ${host.state.kinds.cache}, rate limit ${host.state.kinds.rateLimit}`);
      console.log(`packs: ${host.packs.map((p) => `${p.name}@${p.version}`).join(", ")}`);
      await host.close();
      return;
    }
    const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
    const serving = await serve({ file, port: Number(process.env.PORT ?? 3939), ...(allowedHosts ? { allowedHosts } : {}) });
    const { host, port } = serving;
    console.log(`TypeSystem host "${host.deployment.name}" (build ${host.build}) on http://localhost:${port}: MCP at /mcp, API at /api`);
    console.log(`state: audit ${host.state.kinds.audit} (chain ${host.state.audit.chain}), workflows ${host.state.kinds.workflows}, cache ${host.state.kinds.cache}, rate limit ${host.state.kinds.rateLimit}`);
    for (const [name, p] of Object.entries(serving.applications)) console.log(`application ${name} on http://localhost:${p}`);
    // A rolling restart sends SIGTERM: write what is pending to the audit trail and sign its last checkpoint before exiting (ADR-0105).
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal}: closing`);
      void serving.close().then(
        () => process.exit(0),
        (err: unknown) => {
          console.error(err);
          process.exit(1);
        }
      );
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  } catch (err) {
    if (err instanceof DeploymentError) {
      console.error(`The deployment does not build:\n${err.problems.map((p) => `  - ${p}`).join("\n")}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
