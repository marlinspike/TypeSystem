import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ServiceName = "fleet-registry" | "parts-depot" | "crew-roster";

/** Where the three independent services live in this repository: plain Node, no TypeSystem code. */
export const SERVICES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/services");

export interface ServiceOptions {
  /** Added to every response, to model a slow system. */
  readonly latencyMs?: number;
  /** The parts depot's schema version. */
  readonly schema?: 1 | 2;
}

export interface RunningService {
  readonly name: ServiceName;
  readonly url: string;
  readonly process: ChildProcess;
  stop(): Promise<void>;
}

/** Starts one service in its own process on a free port, and waits for it to say where. */
export function startService(name: ServiceName, options: ServiceOptions = {}): Promise<RunningService> {
  const child = spawn(process.execPath, [path.join(SERVICES_DIR, name, "server.mjs")], {
    env: { ...process.env, PORT: "0", LATENCY_MS: String(options.latencyMs ?? 0), SCHEMA: String(options.schema ?? 1), EXIT_WITH_PARENT: "1" },
    // The service exits when its stdin closes: when this process ends, however it ends.
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill();
    });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} did not start: ${output}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const m = / on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve({ name, url: m[1]!, process: child, stop });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited (${code}) before it listened: ${output}`));
    });
  });
}

export interface RunningServices {
  readonly fleet: RunningService;
  readonly depot: RunningService;
  readonly roster: RunningService;
  stop(): Promise<void>;
}

/** All three, each in its own process; stopped when this process exits. */
export async function startServices(options: { latencyMs?: Partial<Record<ServiceName, number>>; depotSchema?: 1 | 2 } = {}): Promise<RunningServices> {
  const [fleet, depot, roster] = await Promise.all([
    startService("fleet-registry", { latencyMs: options.latencyMs?.["fleet-registry"] ?? 0 }),
    startService("parts-depot", { latencyMs: options.latencyMs?.["parts-depot"] ?? 0, schema: options.depotSchema ?? 1 }),
    startService("crew-roster", { latencyMs: options.latencyMs?.["crew-roster"] ?? 0 })
  ]);
  const all = [fleet, depot, roster];
  const kill = () => all.forEach((s) => s.process.kill());
  process.once("exit", kill);
  return {
    fleet,
    depot,
    roster,
    stop: async () => {
      process.off("exit", kill);
      await Promise.all(all.map((s) => s.stop()));
    }
  };
}
