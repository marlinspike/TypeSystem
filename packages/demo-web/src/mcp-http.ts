/**
 * The demo MCP server over Streamable HTTP (ADR-0021): the airforce testbed and its static demo tokens
 * behind `@typesys/mcp-server`. `npm run mcp:http` runs it and the Dockerfile's image ships it. It lives
 * here, not in the library, because the library names no domain (ADR-0050). Demonstration only: the
 * testbed is in-memory and the tokens are constants in source.
 */
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { startHttpServer } from "@typesys/mcp-server";

const port = Number(process.env.PORT ?? 3939);
await startHttpServer(port, { backend: await buildAirforceTestbed(), identityResolver: resolveDemoIdentity });
