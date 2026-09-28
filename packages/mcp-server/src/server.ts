import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { buildAirforceTestbed, type AirforceTestbed } from "@typesys/domain-airforce";
import { registerResourceHandlers } from "./resources.js";
import { registerToolHandlers } from "./tools.js";
import { resolveDemoIdentity, type IdentityResolver } from "./auth.js";

export interface TypeSysMcpServer extends AirforceTestbed {
  server: Server;
}

/**
 * Wires the vertical slice into an MCP server: bootstraps the registry +
 * runtime (core + airforce domain, both adapter styles seeded), then
 * registers the resource and tool handlers against it. The bootstrap is
 * the only place a new domain package would need to be added (see
 * docs/developer-guide/adding-a-domain.md) — resources.ts/tools.ts stay
 * generic over whatever the registry holds.
 *
 * Accepts an already-built testbed so another process (e.g. the demo web
 * app) can share the exact same registry/runtime/audit-log instance as
 * the MCP server, proving both surfaces enforce identical governance
 * against identical state rather than merely similar-looking code. When
 * omitted, a fresh testbed is built (this is what every existing caller —
 * the CLI entrypoint, the contract test — still does).
 *
 * Accepts an `IdentityResolver`, defaulting to the static demo token map
 * (`resolveDemoIdentity`) — pass `@typesys/auth-oidc`'s
 * `createOidcIdentityResolver(...)` for real OIDC/JWT verification
 * (ADR-0018) without changing anything else about this server.
 */
export async function createServer(testbed?: AirforceTestbed, identityResolver: IdentityResolver = resolveDemoIdentity): Promise<TypeSysMcpServer> {
  const bundle = testbed ?? (await buildAirforceTestbed());
  const server = new Server({ name: "typesys-mcp-server", version: "0.1.0" }, { capabilities: { resources: {}, tools: {} } });

  registerResourceHandlers(server, bundle.registry, bundle.runtime, identityResolver);
  registerToolHandlers(server, bundle.registry, bundle.runtime, identityResolver);

  return { ...bundle, server };
}
