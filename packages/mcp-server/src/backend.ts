import type { SemanticRegistry, SemanticRuntime } from "@typesys/core";
import type { IdentityResolver } from "./auth.js";

/**
 * What an MCP server serves: a registry and the runtime over it (ADR-0050).
 * Whatever `buildRuntime` returns satisfies it, and extra fields — a domain
 * testbed's adapters, say — are allowed and passed through untouched.
 */
export interface McpBackend {
  registry: SemanticRegistry;
  runtime: SemanticRuntime;
}

/** The `{ name, version }` a server announces to its clients in `initialize`. */
export interface McpServerInfo {
  name?: string;
  version?: string;
}

export const DEFAULT_SERVER_INFO = { name: "typesys-mcp-server", version: "0.1.0" } as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The checks a JavaScript caller (or a cast) can bypass the types with. A server that can't say whose
 * data it serves, or who is asking, doesn't start (ADR-0050): it never falls back to an identity or a
 * dataset of its own.
 */
export function requireBackend(caller: string, backend: unknown): McpBackend {
  if (!isObject(backend) || !isObject(backend.registry) || !isObject(backend.runtime)) {
    throw new TypeError(`${caller} needs a backend: { registry, runtime } (what buildRuntime returns)`);
  }
  return backend as unknown as McpBackend;
}

export function requireIdentityResolver(caller: string, resolver: unknown): IdentityResolver {
  if (typeof resolver !== "function") {
    throw new TypeError(`${caller} needs an identity resolver: a function from a token to an Identity. It assumes no identity of its own.`);
  }
  return resolver as IdentityResolver;
}
