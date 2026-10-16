/**
 * The demo MCP server over stdio: the airforce testbed behind `@typesys/mcp-server`, for a locally
 * spawned agent (`npm run smoke:mcp` drives it). It lives here, not in the library, because the library
 * names no domain (ADR-0050); a project runs its own entry point, as docs/how-to/start-a-project.md shows.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { agentAudienceFromEnvironment } from "@typesys/llm";
import { createServer } from "@typesys/mcp-server";

// TYPESYS_AGENT_MODEL names the model behind the agent (ADR-0075): everything it reads is decided for its user and that model.
const audience = await agentAudienceFromEnvironment();
const { server } = createServer(await buildAirforceTestbed(), resolveDemoIdentity, {}, audience ? { audience } : {});
await server.connect(new StdioServerTransport());
