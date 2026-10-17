import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startService, type RunningService } from "@typesys/cold-chain";
import { SERVICES, SIMULATED_LLM, SURFACES, type ServiceKey, type SurfaceKey } from "./catalog.js";
import { startSimulatedModel, type SimulatedModel } from "./simulated-model.js";

/** The repository root: the showcase runs the repository's own demos, built. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const TSX = path.join(ROOT, "node_modules/.bin/tsx");

/**
 * The model configuration Cold Chain Command runs with in the showcase: the
 * one TYPESYS_LLM_CONFIG names, else the simulated endpoint's, so its
 * stability assessment goes through the real provider path (the OpenAI SDK
 * over HTTP) to a deterministic answer. Relative to the repository root.
 */
export function coldChainModelConfig(env: NodeJS.ProcessEnv = process.env): string {
  return env.TYPESYS_LLM_CONFIG ? path.relative(ROOT, path.resolve(env.TYPESYS_LLM_CONFIG)) : SIMULATED_LLM.config;
}

/** How each surface (but the guide) is started: the same command its own documentation gives. */
const COMMANDS: Record<Exclude<SurfaceKey, "guide">, { readonly command: string; readonly args: readonly string[]; readonly env?: Record<string, string>; readonly needs: readonly string[] }> = {
  demo: { command: TSX, args: ["packages/demo-web/src/server.ts"], needs: ["packages/core/dist/index.js"] },
  studioAirforce: { command: TSX, args: ["scripts/studio.ts"], env: { TYPESYS_STUDIO_DOMAIN: "airforce" }, needs: ["packages/studio/dist/public/studio.js"] },
  studioColdChain: { command: TSX, args: ["scripts/studio.ts"], env: { TYPESYS_STUDIO_DOMAIN: "cold-chain" }, needs: ["packages/studio/dist/public/studio.js", "examples/apps/cold-chain/dist/server.js", "examples/apps/recall-response/dist/server.js"] },
  coldChain: { command: process.execPath, args: ["examples/apps/cold-chain/dist/server.js"], env: { TYPESYS_LLM_CONFIG: coldChainModelConfig() }, needs: ["examples/apps/cold-chain/dist/server.js"] },
  recall: { command: process.execPath, args: ["examples/apps/recall-response/dist/server.js"], needs: ["examples/apps/recall-response/dist/server.js"] }
};

export interface Preflight {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly fixes: readonly string[];
}

/** Whether a port on loopback is free. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** What must be true before anything starts: the builds exist and every port is free. Says what to run when not. */
export async function preflight(only: readonly SurfaceKey[] = Object.keys(SURFACES) as SurfaceKey[]): Promise<Preflight> {
  const problems: string[] = [];
  const fixes = new Set<string>();
  for (const key of only) {
    if (key === "guide") continue;
    for (const file of COMMANDS[key].needs) {
      if (existsSync(path.join(ROOT, file))) continue;
      problems.push(`${SURFACES[key].title} needs ${file}, which is not built`);
      if (file.startsWith("examples/apps/")) fixes.add(`npx typesys app build ${file.split("/").slice(0, 3).join("/")}`);
      else fixes.add("npm run build");
    }
  }
  if (!existsSync(TSX)) {
    problems.push("tsx is not installed");
    fixes.add("npm install");
  }
  const ports = [...only.map((k) => SURFACES[k].port), ...Object.values(SERVICES).map((s) => s.port), SIMULATED_LLM.port];
  for (const port of ports) if (!(await portFree(port))) problems.push(`port ${port} is in use`);
  if (problems.some((p) => p.startsWith("port"))) fixes.add("stop whatever holds those ports (an earlier showcase, `npm run demo`, `npm run studio`), then start again");
  return { ok: problems.length === 0, problems, fixes: [...fixes] };
}

export interface SurfaceProcess {
  readonly key: SurfaceKey;
  readonly url: string;
  readonly process: ChildProcess;
  output: string;
}

/**
 * Everything the showcase runs: one copy of each independent service on a
 * fixed port, the simulated model, and every surface pointed at those
 * services through the environment, so the applications and Studio read
 * and write the same systems.
 */
export class Stack {
  readonly services = new Map<ServiceKey, RunningService>();
  readonly surfaces = new Map<SurfaceKey, SurfaceProcess>();
  model?: SimulatedModel;
  private stopping = false;

  constructor(private readonly only: readonly SurfaceKey[] = Object.keys(SURFACES) as SurfaceKey[]) {}

  /** The environment every surface gets: where the services are, and nothing else of the showcase's. */
  serviceEnv(): Record<string, string> {
    return Object.fromEntries(Object.entries(SERVICES).map(([, s]) => [s.env, `http://127.0.0.1:${s.port}`]));
  }

  async start(log: (line: string) => void = () => {}): Promise<void> {
    await Promise.all((Object.keys(SERVICES) as ServiceKey[]).map((k) => this.startServiceKey(k)));
    log(`services: ${[...this.services.values()].map((s) => `${s.name} ${s.url}`).join(", ")}`);
    this.model = await startSimulatedModel(SIMULATED_LLM.port);
    log(`simulated model (OpenAI-compatible, deterministic): ${this.model.url}`);
    await Promise.all(this.only.filter((k): k is Exclude<SurfaceKey, "guide"> => k !== "guide").map((k) => this.startSurface(k, log)));
  }

  async startServiceKey(key: ServiceKey): Promise<RunningService> {
    const s = await startService(key, { port: SERVICES[key].port });
    this.services.set(key, s);
    return s;
  }

  /** Stops one service, as an outage: every surface keeps running and reads around it. */
  async stopService(key: ServiceKey): Promise<void> {
    const s = this.services.get(key);
    this.services.delete(key);
    await s?.stop();
  }

  /** Every service back to its first state (each holds its data in memory), and the surfaces' own in-memory runs with it. */
  async reset(log: (line: string) => void = () => {}): Promise<void> {
    await Promise.all([...this.services.keys()].map((k) => this.stopService(k)));
    await Promise.all((Object.keys(SERVICES) as ServiceKey[]).map((k) => this.startServiceKey(k)));
    for (const key of [...this.surfaces.keys()]) {
      if (key === "guide") continue;
      const p = this.surfaces.get(key)!;
      await stopChild(p.process);
      this.surfaces.delete(key);
      await this.startSurface(key, log);
    }
  }

  private startSurface(key: Exclude<SurfaceKey, "guide">, log: (line: string) => void): Promise<void> {
    const c = COMMANDS[key];
    const port = SURFACES[key].port;
    const child = spawn(c.command, [...c.args], {
      cwd: ROOT,
      env: { ...process.env, ...this.serviceEnv(), ...c.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const entry: SurfaceProcess = { key, url: `http://127.0.0.1:${port}`, process: child, output: "" };
    this.surfaces.set(key, entry);
    const keep = (chunk: Buffer) => (entry.output = (entry.output + chunk.toString()).slice(-4000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("exit", (code) => {
      if (!this.stopping && this.surfaces.get(key) === entry) log(`${SURFACES[key].title} exited (${code}): ${entry.output.trim().split("\n").slice(-3).join(" | ")}`);
    });
    return waitForHttp(entry.url, 60_000, () => child.exitCode !== null).then(
      () => log(`${SURFACES[key].title}: ${entry.url}`),
      (err: Error) => log(`${SURFACES[key].title} did not start: ${err.message}: ${entry.output.trim().split("\n").slice(-3).join(" | ")}`)
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.surfaces.values()].map((s) => stopChild(s.process)));
    await Promise.all([...this.services.values()].map((s) => s.stop()));
    await this.model?.close();
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  });
}

/** Waits until a URL answers at all (any status), or gives up. */
export async function waitForHttp(url: string, timeoutMs: number, gaveUp: () => boolean = () => false): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      if (gaveUp()) throw new Error("the process exited");
      if (Date.now() > until) throw new Error(`no answer from ${url} after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
