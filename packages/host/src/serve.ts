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
import { pathToFileURL } from "node:url";
import { createApiApp } from "@typesys/http";
import { agentAudienceFromEnvironment } from "@typesys/llm";
import { createHttpApp } from "@typesys/mcp-server";
import { DeploymentError } from "./deployment.js";
import { buildHost, type Host } from "./host.js";
import { loadDeployment, loadExtensions } from "./load.js";

export interface ServeOptions {
  readonly file: string;
  readonly port?: number;
  readonly allowedHosts?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Loads and builds the host a deployment file describes. */
export async function hostFromFile(file: string): Promise<Host> {
  const { deployment, packs } = await loadDeployment(file);
  const extensions = await loadExtensions(deployment);
  return buildHost(deployment, { packs, extensions });
}

/** Builds the host and serves it; resolves once listening. */
export async function serve(opts: ServeOptions): Promise<{ host: Host; port: number; close(): Promise<void> }> {
  const host = await hostFromFile(opts.file);
  const audience = await agentAudienceFromEnvironment(opts.env ?? process.env);
  const allowedHosts = opts.allowedHosts?.length ? opts.allowedHosts : undefined;
  const app = createHttpApp({
    backend: host,
    identityResolver: host.identityResolver,
    serverInfo: { name: host.deployment.name, version: host.build },
    ...(audience ? { audience } : {}),
    ...(allowedHosts ? { allowedHosts } : {})
  });
  // Which build is serving: what an operator checks after rolling a new image or deployment file (ADR-0101).
  app.get("/version", (_req, res) => void res.json({ deployment: host.deployment.name, build: host.build, packs: host.packs.map((p) => `${p.name}@${p.version}`) }));
  const personas = Object.values(host.personas);
  app.use(
    createApiApp({
      backend: host,
      identityResolver: host.identityResolver,
      subjects: {
        list: async () => personas.map((p) => ({ subjectId: p.subjectId })),
        resolve: async (subjectId) => personas.find((p) => p.subjectId === subjectId)
      },
      ...(allowedHosts ? { allowedHosts } : {})
    })
  );
  return new Promise((resolve) => {
    const server = app.listen(opts.port ?? 3939, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (opts.port ?? 3939);
      resolve({
        host,
        port,
        close: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          await host.close();
        }
      });
    });
  });
}

async function main(): Promise<void> {
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
      console.log(`packs: ${host.packs.map((p) => `${p.name}@${p.version}`).join(", ")}`);
      await host.close();
      return;
    }
    const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
    const { host, port } = await serve({ file, port: Number(process.env.PORT ?? 3939), ...(allowedHosts ? { allowedHosts } : {}) });
    console.log(`TypeSystem host "${host.deployment.name}" (build ${host.build}) on http://localhost:${port}: MCP at /mcp, API at /api`);
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
