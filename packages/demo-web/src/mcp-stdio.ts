/**
 * The demo MCP server over stdio: the airforce testbed behind `@typesys/mcp-server`, for a locally
 * spawned agent (`npm run smoke:mcp` drives it). It lives here, not in the library, because the library
 * names no domain (ADR-0050); a project runs its own entry point, as docs/how-to/start-a-project.md shows.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createServer } from "@typesys/mcp-server";

const { server } = createServer(await buildAirforceTestbed(), resolveDemoIdentity);
await server.connect(new StdioServerTransport());
