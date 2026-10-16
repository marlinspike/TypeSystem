/**
 * The demo MCP server over Streamable HTTP (ADR-0021): the airforce testbed and its static demo tokens
 * behind `@typesys/mcp-server`. `npm run mcp:http` runs it and the Dockerfile's image ships it. It lives
 * here, not in the library, because the library names no domain (ADR-0050). Demonstration only: the
 * testbed is in-memory and the tokens are constants in source.
 */
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { agentAudienceFromEnvironment } from "@typesys/llm";
import { startHttpServer } from "@typesys/mcp-server";

const port = Number(process.env.PORT ?? 3939);
// Host names this server answers to, comma-separated (ADR-0053). Unset: localhost only. A container behind a
// real name sets it, e.g. MCP_ALLOWED_HOSTS=typesys.example.org.
const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
// TYPESYS_AGENT_MODEL names the model behind the agents this server answers (ADR-0075).
const audience = await agentAudienceFromEnvironment();
await startHttpServer(port, {
  backend: await buildAirforceTestbed(),
  ...(audience ? { audience } : {}),
  identityResolver: resolveDemoIdentity,
  ...(allowedHosts?.length ? { allowedHosts } : {})
});
