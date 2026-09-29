#!/usr/bin/env -S npx tsx
/**
 * One replica for `scripts/load-test.ts`: the airforce testbed behind the
 * Streamable HTTP MCP transport, in its own process. With REDIS_URL set it
 * uses the shared RedisCache/RedisRateLimiter (ADR-0025); without it, the
 * per-process in-memory ones. Prints `ready <port>` once listening.
 *
 * Env: PORT (0 = any free port), REDIS_URL, REDIS_PREFIX, RATE_LIMIT_CAPACITY,
 * RATE_LIMIT_REFILL_PER_SECOND, MOCK_REST_LATENCY_MS.
 */
import { createClient } from "redis";
import { InMemoryRateLimiter, type SemanticRuntimeOptions } from "@typesys/core";
import { buildAirforceTestbed } from "@typesys/domain-airforce";
import { startHttpServer } from "@typesys/mcp-server";
import { RedisCache, RedisRateLimiter } from "@typesys/redis";

const env = process.env;
const capacity = env.RATE_LIMIT_CAPACITY ? Number(env.RATE_LIMIT_CAPACITY) : undefined;
const refillPerSecond = Number(env.RATE_LIMIT_REFILL_PER_SECOND ?? 0);
const prefix = env.REDIS_PREFIX ?? "typesys-loadtest:";

const runtimeOptions: SemanticRuntimeOptions = {};
if (env.REDIS_URL) {
  const client = createClient({ url: env.REDIS_URL });
  await client.connect();
  runtimeOptions.cache = new RedisCache(client, { keyPrefix: `${prefix}cache:` });
  if (capacity !== undefined) {
    runtimeOptions.rateLimiter = new RedisRateLimiter(client, { capacity, refillPerSecond, keyPrefix: `${prefix}ratelimit:` });
  }
} else if (capacity !== undefined) {
  runtimeOptions.rateLimiter = new InMemoryRateLimiter({ capacity, refillPerSecond });
}

const testbed = await buildAirforceTestbed({
  runtimeOptions,
  mockRestLatencyMs: env.MOCK_REST_LATENCY_MS ? Number(env.MOCK_REST_LATENCY_MS) : undefined
});
// startHttpServer logs its own banner; the parent process only reads the `ready` line.
const running = await startHttpServer(Number(env.PORT ?? 0), { testbed });
console.log(`ready ${running.port}`);

process.on("SIGTERM", () => {
  void running.close().finally(() => process.exit(0));
});
