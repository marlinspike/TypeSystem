import { watchFile, unwatchFile, existsSync } from "node:fs";
import path from "node:path";
import { AdapterUnavailableError } from "@typesys/core";
import { DeploymentError } from "./deployment.js";
import { buildHost } from "./host.js";
import { loadDeployment, loadExtensions } from "./load.js";
import { serve, type Serving } from "./serve.js";
import { loadTests, renderTests, runTests, testsFileFor } from "./tests.js";

/**
 * `typesys dev <deployment.json>` (ADR-0112): the generic server for one
 * developer's machine. It serves the deployment exactly as the server in an
 * image does, prints what a newcomer needs to make a first call (each
 * persona's token, a `curl`, an MCP client's configuration), runs the
 * deployment's policy tests, and builds and serves it again whenever the
 * deployment, a pack or the tests change. A change that does not build is
 * reported and the last build that did keeps serving. This is restart on
 * change, on one machine; production keeps restarting by rollout.
 */
export const DEV_USAGE = `typesys dev <deployment.json> [--port <n>] [--packs-dir <dir>] [--once]

  Serves the deployment on this machine (MCP at /mcp, the API under /api), prints each
  persona's token with a first call to make, runs <name>.tests.json beside it when there
  is one, and serves it again whenever the deployment, its packs or its tests change. A
  change that does not build is reported, and the last build that did keeps serving.
  --once serves without watching. PORT sets the port when --port is not given.`;

interface DevArgs {
  file?: string;
  port?: number;
  packsDir?: string;
  once: boolean;
  help: boolean;
}

function parse(argv: readonly string[]): DevArgs {
  const out: DevArgs = { once: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--port") {
      const p = Number(next());
      if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error("--port must be a port number");
      out.port = p;
    } else if (a === "--packs-dir") out.packsDir = next();
    else if (a === "--once") out.once = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else if (out.file === undefined) out.file = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  return out;
}

/** What to print once a build is serving: where, who, and a first call for each persona. */
export function welcome(serving: Serving): string {
  const { host, port } = serving;
  const base = `http://localhost:${port}`;
  const tokens = host.deployment.identity.kind === "tokens" ? host.deployment.identity.tokens : {};
  const byPersona = new Map<string, string>();
  for (const [token, persona] of Object.entries(tokens)) if (!byPersona.has(persona)) byPersona.set(persona, token);
  const types = host.packs.length ? [...new Set(Object.values(host.deployment.sources).flatMap((s) => (s.kind === "extension" ? [] : Object.keys(s.types))))] : [];
  const first = types[0];
  const lines = [
    `${host.deployment.name} is serving (build ${host.build.slice(0, 19)}…)`,
    `  API  ${base}/api        MCP  ${base}/mcp        index  ${base}/`,
    ""
  ];
  if (byPersona.size > 0) {
    lines.push("Personas and their tokens (fixed tokens: this machine only):");
    for (const [persona, token] of byPersona) {
      const roles = host.personas[persona]?.roles ?? [];
      lines.push(`  ${persona.padEnd(10)} ${token}   roles: ${roles.length ? roles.join(", ") : "none"}`);
    }
    lines.push("");
    const [persona, token] = [...byPersona][0]!;
    if (first) {
      lines.push(`A first call, as ${persona}:`);
      lines.push(`  curl -s -X POST ${base}/api/query -H 'authorization: Bearer ${token}' -H 'content-type: application/json' -d '{"type":"${first}","limit":5}'`);
    }
    lines.push(`Connect Claude Code to it, as ${persona}:`);
    lines.push(`  claude mcp add --transport http ${host.deployment.name} ${base}/mcp --header "Authorization: Bearer ${token}"`);
  } else {
    lines.push(`Identity: ${host.deployment.identity.kind}. Call with a bearer token your identity provider issues.`);
  }
  return lines.join("\n");
}

/** `typesys dev`: resolves with the exit code once it stops (on a signal, or at once when it cannot start). */
export async function devCommand(argv: readonly string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  let args: DevArgs;
  try {
    args = parse(argv);
  } catch (e) {
    err(`${(e as Error).message}\n\n${DEV_USAGE}`);
    return 2;
  }
  if (args.help || !args.file) {
    (args.help ? out : err)(DEV_USAGE);
    return args.help ? 0 : 2;
  }
  const file = path.resolve(args.file);
  const testsFile = testsFileFor(file);
  const port = args.port ?? Number(process.env.PORT ?? 3939);
  let current: Serving | undefined;

  const report = (e: unknown) => {
    if (e instanceof DeploymentError) err(`The deployment does not build:\n${e.problems.map((p) => `  - ${p}`).join("\n")}`);
    else if (e instanceof AdapterUnavailableError) err(`A source cannot be reached: ${e.message}`);
    else if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") err(`Port ${port} is in use: stop what is serving there, or pass --port`);
    else err(`Could not serve it: ${(e as Error).message}`);
  };

  const runTestsOf = async (serving: Serving) => {
    if (!existsSync(testsFile)) {
      out(`No policy tests yet: write ${path.relative(process.cwd(), testsFile)} (ADR-0113) to check what each persona may see.`);
      return;
    }
    try {
      const r = await runTests(serving.host, await loadTests(testsFile, serving.host));
      out(`Policy tests (${path.relative(process.cwd(), testsFile)}):\n${renderTests(r)}`);
    } catch (e) {
      report(e);
    }
  };

  /** Builds the deployment; if it builds, swaps it in for what is serving. */
  const start = async (): Promise<boolean> => {
    const opts = { file, port, ...(args.packsDir ? { packsDir: args.packsDir } : {}) };
    if (current) {
      // Built and checked first, in memory, so a change that does not build never stops what is serving.
      try {
        const { deployment, packs } = await loadDeployment(file, args.packsDir ? { packsDir: args.packsDir } : {});
        const trial = await buildHost(deployment, { packs, extensions: await loadExtensions(deployment), state: "memory" });
        try {
          const problems = await trial.checkSources().catch((e: unknown) => {
            if (e instanceof AdapterUnavailableError) return [];
            throw e;
          });
          if (problems.length > 0) throw new DeploymentError(problems);
        } finally {
          await trial.close();
        }
      } catch (e) {
        report(e);
        return false;
      }
      await current.close();
      current = undefined;
    }
    try {
      current = await serve(opts);
    } catch (e) {
      report(e);
      return false;
    }
    out(welcome(current));
    await runTestsOf(current);
    return true;
  };

  if (!(await start()) && args.once) return 1;
  if (args.once) out("Serving (--once): Ctrl-C to stop.");

  // The files a build reads: the deployment, its packs, and its tests.
  const watched = new Set<string>();
  const watchAll = async () => {
    const files = new Set<string>([file, testsFile]);
    try {
      const { deployment } = await loadDeployment(file, args.packsDir ? { packsDir: args.packsDir } : {});
      for (const p of deployment.packs) {
        const dir = path.dirname(file);
        const name = `${p.name}-${p.version}.typesys-pack.json`;
        const candidates = p.file ? [path.resolve(dir, p.file)] : [path.join(args.packsDir ?? process.env.TYPESYS_PACKS_DIR ?? path.join(dir, "packs"), name), path.join(dir, name), path.join(dir, "..", "packs", name)];
        for (const c of candidates) files.add(c);
      }
    } catch {
      // A deployment that does not parse is still watched; its packs are found once it does.
    }
    for (const f of watched) if (!files.has(f)) unwatchFile(f);
    for (const f of files) if (!watched.has(f)) watchFile(f, { interval: 300 }, changed);
    watched.clear();
    for (const f of files) watched.add(f);
  };
  let timer: NodeJS.Timeout | undefined;
  let building = Promise.resolve();
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      building = building.then(async () => {
        out(`\nChanged: building ${path.relative(process.cwd(), file)} again`);
        if (!(await start()) && current) out(`Still serving the last build that did: ${current.host.build.slice(0, 19)}…`);
        await watchAll();
      });
    }, 150);
  };
  if (!args.once) {
    await watchAll();
    out(`Watching ${path.relative(process.cwd(), file)}, its packs and its tests. Ctrl-C to stop.`);
  }

  return new Promise<number>((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      for (const f of watched) unwatchFile(f);
      void building.then(async () => {
        await current?.close();
        resolve(0);
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
