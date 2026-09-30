import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DEFAULT_SERVER_INFO, requireBackend, requireIdentityResolver, type McpBackend, type McpServerInfo } from "./backend.js";
import { registerResourceHandlers } from "./resources.js";
import { registerToolHandlers } from "./tools.js";
import type { IdentityResolver } from "./auth.js";

/** The backend it was given, with the MCP `Server` built over it. */
export type TypeSysMcpServer<B extends McpBackend = McpBackend> = B & { server: Server };

/**
 * Wires any registry and runtime into an MCP server: registers the resource
 * and tool handlers against it. `resources.ts` and `tools.ts` are generic
 * over whatever the registry holds, so a new domain never touches them
 * (docs/developer-guide/adding-a-domain.md) — and neither does this (ADR-0050).
 *
 * `backend` is what `buildRuntime` returns. Build it once per process and
 * share it, so every server over it enforces the same governance against
 * the same state (ADR-0021): this function builds nothing and keeps nothing.
 *
 * `resolveIdentity` is the whole of authentication: it turns the token a
 * call carries into an `Identity`, fresh on every call (ADR-0012). It is
 * required — there is no default identity — so a server can't start by
 * accident honouring tokens nobody chose. Pass `@typesys/auth-oidc`'s
 * `createOidcIdentityResolver(...)` for real OIDC/JWT verification (ADR-0018).
 *
 * `info` is what the server announces to clients; it defaults to
 * `typesys-mcp-server` 0.1.0.
 */
export function createServer<B extends McpBackend>(backend: B, resolveIdentity: IdentityResolver, info: McpServerInfo = {}): TypeSysMcpServer<B> {
  requireBackend("createServer", backend);
  requireIdentityResolver("createServer", resolveIdentity);
  const server = new Server(
    { name: info.name ?? DEFAULT_SERVER_INFO.name, version: info.version ?? DEFAULT_SERVER_INFO.version },
    { capabilities: { resources: {}, tools: {} } }
  );

  registerResourceHandlers(server, backend.registry, backend.runtime, resolveIdentity);
  registerToolHandlers(server, backend.registry, backend.runtime, resolveIdentity);

  return { ...backend, server };
}
