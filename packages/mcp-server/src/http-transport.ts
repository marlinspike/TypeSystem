import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AirforceTestbed } from "@typesys/domain-airforce";
import { createServer as createMcpServer } from "./server.js";
import { resolveDemoIdentity, type IdentityResolver } from "./auth.js";

export interface HttpTransportOptions {
  /** Shared with the stdio/in-memory paths so every transport enforces identical governance against identical state (see server.ts). Built fresh if omitted. */
  testbed?: AirforceTestbed;
  /** Defaults to the demo token map — pass `@typesys/auth-oidc`'s `createOidcIdentityResolver(...)` for real bearer-token verification. */
  identityResolver?: IdentityResolver;
}

function bearerTokenFromHeader(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/**
 * A real HTTP transport for the same MCP server `bin.ts` exposes over
 * stdio — `StreamableHTTPServerTransport` in stateless mode
 * (`sessionIdGenerator: undefined`), matching both the MCP 2026-07-28
 * spec generation and this codebase's own stateless-identity design
 * (ADR-0012): a fresh `Server`+transport pair per HTTP request, all
 * sharing one underlying registry/runtime instance built once at
 * startup (see ADR-0021).
 *
 * Identity is resolved from a real `Authorization: Bearer <token>`
 * header — the standard place for it over HTTP — rather than the stdio
 * transport's workaround of a token embedded in a resource URI's query
 * string or a tool call's `authToken` argument. Falls back to that
 * in-band token when no header is present, so existing MCP clients that
 * only know the stdio convention (this repo's own smoke test, an older
 * agent integration) still work unchanged if pointed at this transport.
 */
export function createHttpApp(opts: HttpTransportOptions = {}): Express {
  const baseResolver = opts.identityResolver ?? resolveDemoIdentity;
  const app = express();
  app.use(express.json());

  // Built once, lazily, and shared across every request — never per request,
  // which would silently discard state (and the audit log) between calls.
  let testbedPromise: Promise<AirforceTestbed> | undefined;
  async function getTestbed(): Promise<AirforceTestbed> {
    if (opts.testbed) return opts.testbed;
    testbedPromise ??= import("@typesys/domain-airforce").then((m) => m.buildAirforceTestbed());
    return testbedPromise;
  }

  app.post("/mcp", async (req: Request, res: Response) => {
    const headerToken = bearerTokenFromHeader(req);
    // A fresh resolver per request, closing over *this* request's header —
    // the header is the authoritative source when present; the in-band
    // token (from a resource URI/tool argument) is only a fallback.
    const perRequestResolver: IdentityResolver = (inBandToken) => baseResolver(headerToken ?? inBandToken);

    try {
      const testbed = await getTestbed();
      const { server } = await createMcpServer(testbed, perRequestResolver);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error("Error handling MCP HTTP request:", err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  // Stateless mode has no server-initiated stream or session to resume/close —
  // GET/DELETE only exist in the spec for the stateful case, so reject them the
  // same way the SDK's own stateless example does.
  app.get("/mcp", (_req: Request, res: Response) => jsonRpcError(res, 405, -32000, "Method not allowed."));
  app.delete("/mcp", (_req: Request, res: Response) => jsonRpcError(res, 405, -32000, "Method not allowed."));

  return app;
}

export interface RunningHttpServer {
  /** The actual bound port — useful when `port` was 0 (pick any free port), e.g. in tests. */
  port: number;
  close(): Promise<void>;
}

/** Returns the actual bound port (relevant when `port` is 0) and a `close()` for tests/scripts that need to shut the listener down. */
export function startHttpServer(port: number, opts: HttpTransportOptions = {}): Promise<RunningHttpServer> {
  const app = createHttpApp(opts);
  return new Promise<RunningHttpServer>((resolve) => {
    const server = app.listen(port, () => {
      const boundPort = typeof server.address() === "object" ? (server.address() as { port: number }).port : port;
      console.log(`TypeS MCP server (Streamable HTTP) listening on http://localhost:${boundPort}/mcp`);
      resolve({ port: boundPort, close: () => new Promise<void>((res) => server.close(() => res())) });
    });
  });
}
