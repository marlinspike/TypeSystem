import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ServiceName = "shipment-tracker" | "sensor-hub" | "pharmacy-inventory" | "recall-exchange";

/** Where the independent services live in this repository: plain Node, no TypeSystem code. */
export const SERVICES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/services");

export interface ServiceOptions {
  /** Added to every response, to model a slow system. */
  readonly latencyMs?: number;
  /** A fixed port, so a restarted service is found where it was (the showcase's outage and reset). Default: a free one. */
  readonly port?: number;
}

export interface RunningService {
  readonly name: ServiceName;
  readonly url: string;
  readonly process: ChildProcess;
  stop(): Promise<void>;
}

/** Starts one service in its own process, on a free port unless given one, and waits for it to say where. */
export function startService(name: ServiceName, options: ServiceOptions = {}): Promise<RunningService> {
  const child = spawn(process.execPath, [path.join(SERVICES_DIR, name, "server.mjs")], {
    env: { ...process.env, PORT: String(options.port ?? 0), LATENCY_MS: String(options.latencyMs ?? 0), EXIT_WITH_PARENT: "1" },
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
  readonly tracker: RunningService;
  readonly sensors: RunningService;
  readonly inventory: RunningService;
  stop(): Promise<void>;
}

/** All three, each in its own process; stopped when this process exits. */
export async function startServices(options: { latencyMs?: Partial<Record<ServiceName, number>> } = {}): Promise<RunningServices> {
  const [tracker, sensors, inventory] = await Promise.all(
    (["shipment-tracker", "sensor-hub", "pharmacy-inventory"] as const).map((name) => startService(name, { latencyMs: options.latencyMs?.[name] ?? 0 }))
  );
  const all = [tracker!, sensors!, inventory!];
  const kill = () => all.forEach((s) => s.process.kill());
  process.once("exit", kill);
  return {
    tracker: tracker!,
    sensors: sensors!,
    inventory: inventory!,
    stop: async () => {
      process.off("exit", kill);
      await Promise.all(all.map((s) => s.stop()));
    }
  };
}
