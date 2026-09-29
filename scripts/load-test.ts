#!/usr/bin/env -S npx tsx
/**
 * Load test (docs/PRODUCTION-READINESS.md item 5; ADR-0025): starts N
 * separate server processes (`scripts/load-test-instance.ts`) and drives
 * them with concurrent MCP clients over Streamable HTTP, round-robin across
 * instances, for a fixed duration. The workload mixes an object read, a
 * relationship read, and a `query` with an include tree, so requests exercise
 * policy, redaction, cross-adapter resolution, computed properties, and the
 * per-request concurrency budget together.
 *
 * Reports throughput, p50/p95/p99/max latency per operation, and errors.
 * With RATE_LIMIT_CAPACITY set, every client shares one identity, so it
 * also checks the rate limiter under contention: with REDIS_URL, the
 * instances must admit at most one shared budget between them; without it,
 * each process enforces its own, and the report shows how far the total
 * overshoots. A rate-limited run uses only object reads, because every
 * nested runtime call is also rate-limited (ADR-0019): a query with includes
 * spends many tokens, an object read exactly one, which keeps "requests
 * admitted" equal to "tokens spent".
 *
 * Exits non-zero on any unexpected error, or if a shared budget is exceeded,
 * so a short run can gate CI.
 *
 * Env (all optional): LOAD_INSTANCES (2), LOAD_CONCURRENCY (32),
 * LOAD_DURATION_S (10), REDIS_URL, RATE_LIMIT_CAPACITY,
 * RATE_LIMIT_REFILL_PER_SECOND (0), MOCK_REST_LATENCY_MS (5).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createClient } from "redis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const INSTANCES = Number(env.LOAD_INSTANCES ?? 2);
const CONCURRENCY = Number(env.LOAD_CONCURRENCY ?? 32);
const DURATION_S = Number(env.LOAD_DURATION_S ?? 10);
const CAPACITY = env.RATE_LIMIT_CAPACITY ? Number(env.RATE_LIMIT_CAPACITY) : undefined;
const REFILL = Number(env.RATE_LIMIT_REFILL_PER_SECOND ?? 0);
const LATENCY_MS = env.MOCK_REST_LATENCY_MS ?? "5";
// A fresh namespace per run, so a previous run's cache or spent rate-limit budget can't leak in.
const REDIS_PREFIX = `typesys-loadtest:${Date.now()}:`;
const STARTUP_TIMEOUT_MS = 30_000;

type Outcome = "ok" | "rateLimited" | "error";
interface Sample {
  op: string;
  ms: number;
  outcome: Outcome;
  instance: number;
  detail?: string;
}

const OPS: { name: string; weight: number; run: (c: Client) => Promise<{ isError?: boolean; text?: string }> }[] = [
  {
    name: "read object",
    weight: 2,
    run: async (c) => {
      await c.readResource({ uri: "typesys://objects/airforce.Aircraft/AF86-0147" });
      return {};
    }
  },
  {
    name: "read relationship",
    weight: 1,
    run: async (c) => {
      await c.readResource({ uri: "typesys://objects/airforce.Aircraft/AF86-0147/relationships/maintenance" });
      return {};
    }
  },
  {
    name: "query + includes",
    weight: 1,
    run: async (c) => {
      const r = await c.callTool({
        name: "query",
        arguments: { type: "airforce.Aircraft", limit: 10, include: [{ relationship: "components" }, { relationship: "maintenance", include: [{ relationship: "workOrder" }] }] }
      });
      const text = (r.content as { type: string; text?: string }[] | undefined)?.[0]?.text;
      return { isError: r.isError === true, text };
    }
  }
];
const WEIGHTED =
  CAPACITY !== undefined ? OPS.filter((op) => op.name === "read object") : OPS.flatMap((op) => Array.from({ length: op.weight }, () => op));

function startInstance(i: number): Promise<{ port: number; child: ChildProcess }> {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "scripts/load-test-instance.ts")], {
    cwd: root,
    env: {
      ...env,
      PORT: "0",
      MOCK_REST_LATENCY_MS: LATENCY_MS,
      REDIS_PREFIX,
      ...(CAPACITY !== undefined ? { RATE_LIMIT_CAPACITY: String(CAPACITY), RATE_LIMIT_REFILL_PER_SECOND: String(REFILL) } : {})
    },
    stdio: ["ignore", "pipe", "inherit"]
  });
  return new Promise((resolve, reject) => {
    // An unreachable Redis makes the instance wait on connect forever; fail the run instead of hanging CI.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`instance ${i} not ready within ${STARTUP_TIMEOUT_MS / 1000}s (is REDIS_URL reachable?)`));
    }, STARTUP_TIMEOUT_MS);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const match = /^ready (\d+)$/.exec(line);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), child });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`instance ${i} exited with code ${code} before becoming ready`));
    });
  });
}

/** Rate-limit denials are the expected outcome of a limit, not a failure — tell them apart from everything else. */
function classify(err: unknown, result?: { isError?: boolean; text?: string }): { outcome: Outcome; detail?: string } {
  const message = err instanceof Error ? err.message : result?.isError ? (result.text ?? "") : undefined;
  if (message === undefined) return { outcome: "ok" };
  return /rate limit exceeded/i.test(message) ? { outcome: "rateLimited" } : { outcome: "error", detail: message.slice(0, 160) };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function main(): Promise<void> {
  console.log(
    `Load test: ${INSTANCES} instance(s), ${CONCURRENCY} concurrent clients, ${DURATION_S}s, mock REST latency ${LATENCY_MS}ms, ` +
      `${env.REDIS_URL ? "shared Redis cache/limiter" : "per-process in-memory state"}` +
      (CAPACITY !== undefined ? `, rate limit ${CAPACITY} burst + ${REFILL}/s per identity` : ", no rate limit")
  );

  const starting = Array.from({ length: INSTANCES }, (_, i) => startInstance(i));
  const instances = await Promise.all(starting).catch(async (err: unknown) => {
    // Don't leave the instances that did start running.
    for (const r of await Promise.allSettled(starting)) if (r.status === "fulfilled") r.value.child.kill("SIGTERM");
    throw err;
  });
  const samples: Sample[] = [];
  let exitCode = 0;

  try {
    const clients = await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_, w) => {
        const instance = w % INSTANCES;
        const client = new Client({ name: `load-${w}`, version: "0.0.0" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://localhost:${instances[instance]!.port}/mcp`), {
            requestInit: { headers: { Authorization: "Bearer demo-maintainer-token" } }
          })
        );
        return { client, instance };
      })
    );

    const startedAt = performance.now();
    const deadline = startedAt + DURATION_S * 1000;
    await Promise.all(
      clients.map(async ({ client, instance }, w) => {
        for (let n = w; performance.now() < deadline; n++) {
          const op = WEIGHTED[n % WEIGHTED.length]!;
          const t0 = performance.now();
          let result: { isError?: boolean; text?: string } | undefined;
          let error: unknown;
          try {
            result = await op.run(client);
          } catch (err) {
            error = err;
          }
          samples.push({ op: op.name, ms: performance.now() - t0, instance, ...classify(error, result) });
        }
      })
    );
    const elapsedS = (performance.now() - startedAt) / 1000;
    await Promise.all(clients.map(({ client }) => client.close()));

    console.log(`\n${samples.length} requests in ${elapsedS.toFixed(1)}s = ${(samples.length / elapsedS).toFixed(0)} req/s\n`);
    console.log("operation           count    ok      p50ms   p95ms   p99ms   maxms");
    for (const op of [...OPS.map((o) => o.name), "all"]) {
      const rows = samples.filter((s) => op === "all" || s.op === op);
      const okMs = rows.filter((s) => s.outcome === "ok").map((s) => s.ms).sort((a, b) => a - b);
      console.log(
        `${op.padEnd(18)} ${String(rows.length).padStart(6)} ${String(okMs.length).padStart(6)}  ` +
          [50, 95, 99, 100].map((p) => percentile(okMs, p).toFixed(1).padStart(7)).join(" ")
      );
    }
    const perInstance = instances.map((_, i) => samples.filter((s) => s.instance === i).length);
    console.log(`\nper instance: ${perInstance.join(" / ")}`);

    const errors = samples.filter((s) => s.outcome === "error");
    const rateLimited = samples.filter((s) => s.outcome === "rateLimited").length;
    console.log(`rate-limited: ${rateLimited}   unexpected errors: ${errors.length}`);
    if (errors.length > 0) {
      exitCode = 1;
      const kinds = new Map<string, number>();
      for (const e of errors) kinds.set(e.detail ?? "?", (kinds.get(e.detail ?? "?") ?? 0) + 1);
      for (const [detail, count] of kinds) console.log(`  ${count} x ${detail}`);
    }

    if (CAPACITY !== undefined) {
      // Object reads cost one token each, so admitted requests = tokens spent. The budget allows one
      // extra second of refill for connection setup before the timed window.
      const allowed = samples.length - rateLimited;
      const budget = CAPACITY + REFILL * (elapsedS + 1);
      console.log(
        `admitted ${allowed}; one shared budget is ${CAPACITY} + ${REFILL}/s ≈ ${Math.floor(budget)}` +
          (env.REDIS_URL ? "" : `, and ${INSTANCES} per-process limiters allow up to ≈ ${Math.floor(budget * INSTANCES)}`)
      );
      if (env.REDIS_URL && allowed > budget) {
        console.log("FAIL: instances sharing Redis admitted more than one budget");
        exitCode = 1;
      }
      if (allowed < CAPACITY) {
        console.log(`FAIL: admitted fewer than the ${CAPACITY}-request burst; the limiter is over-denying`);
        exitCode = 1;
      }
    }
  } finally {
    for (const { child } of instances) child.kill("SIGTERM");
    if (env.REDIS_URL) {
      const redis = createClient({ url: env.REDIS_URL });
      await redis.connect();
      for await (const keys of redis.scanIterator({ MATCH: `${REDIS_PREFIX}*`, COUNT: 500 })) if (keys.length) await redis.del(keys);
      await redis.close();
    }
  }
  process.exit(exitCode);
}

await main();
