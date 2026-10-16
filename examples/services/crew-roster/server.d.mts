import type { Server } from "node:http";

/** The crew roster service (ADR-0072): a real HTTP server with OAuth2 client credentials, for tests and demonstrations. */
export function createCrewRoster(options?: { latencyMs?: number; failing?: boolean; tokenTtlMs?: number }): {
  server: Server;
  state: { latencyMs: number; failing: boolean; calls: number; tokensIssued: number };
};
