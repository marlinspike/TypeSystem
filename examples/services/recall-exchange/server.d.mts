import type { Server } from "node:http";

/** The recall exchange: a real HTTP server with HTTP Basic client authentication, for tests and demonstrations. */
export function createRecallExchange(options?: { latencyMs?: number; failing?: boolean }): {
  server: Server;
  state: { latencyMs: number; failing: boolean; calls: number; responsesFiled: number };
};
