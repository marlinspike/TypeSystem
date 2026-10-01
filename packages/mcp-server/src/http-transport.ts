import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBackend, requireIdentityResolver, type McpBackend, type McpServerInfo } from "./backend.js";
import { createServer as createMcpServer } from "./server.js";
import type { IdentityResolver } from "./auth.js";

export interface HttpTransportOptions {
  /** What every request is served from — built once by the caller, so every transport and every request enforces identical governance against identical state (see server.ts). */
  backend: McpBackend;
  /** The whole of authentication: a bearer token in, an `Identity` out. Required — there is no default (ADR-0050). Pass `@typesys/auth-oidc`'s `createOidcIdentityResolver(...)` for real verification. */
  identityResolver: IdentityResolver;
  /** What each per-request server announces in `initialize`. */
  serverInfo?: McpServerInfo;
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
 * A real HTTP transport for the same MCP server `createServer` builds for
 * stdio — `StreamableHTTPServerTransport` in stateless mode
 * (`sessionIdGenerator: undefined`), matching this codebase's own
 * stateless-identity design (ADR-0012). The protocol revision is whatever
 * the pinned SDK negotiates (2025-11-25 at most for 1.30.0), not a newer
 * stateless generation. A fresh `Server`+transport pair per HTTP request, all
 * sharing the one backend the caller built (see ADR-0021, ADR-0050).
 *
 * Identity is resolved from a real `Authorization: Bearer <token>`
 * header — the standard place for it over HTTP — rather than the stdio
 * transport's workaround of a token embedded in a resource URI's query
 * string or a tool call's `authToken` argument. Falls back to that
 * in-band token when no header is present, so existing MCP clients that
 * only know the stdio convention (this repo's own smoke test, an older
 * agent integration) still work unchanged if pointed at this transport.
 */
export function createHttpApp(opts: HttpTransportOptions): Express {
  // Checked at runtime too: a JavaScript caller can leave either out, and the server never assumes a dataset or an identity.
  const given = opts as Partial<HttpTransportOptions> | undefined;
  const backend = requireBackend("createHttpApp", given?.backend);
  const baseResolver = requireIdentityResolver("createHttpApp", given?.identityResolver);
  const app = express();
  app.use(express.json());

  // Liveness (ADR-0029): the process is up and serving HTTP. Deliberately no
  // dependency checks, so a transient backend blip doesn't trigger a restart
  // loop. Unauthenticated and side-effect-free — it exposes no domain data.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Readiness (ADR-0029): this replica can actually serve — the registry store
  // answers a cheap read (listActions). With a Postgres-backed RegistryStore
  // this returns 503 whenever Postgres is unreachable, which is exactly when a
  // load balancer should stop routing here. Unauthenticated and side-effect-free.
  app.get("/readyz", async (_req: Request, res: Response) => {
    try {
      await backend.registry.listActions();
      res.status(200).json({ status: "ready" });
    } catch (err) {
      res.status(503).json({ status: "not_ready", error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const headerToken = bearerTokenFromHeader(req);
    // A fresh resolver per request, closing over *this* request's header —
    // the header is the authoritative source when present; the in-band
    // token (from a resource URI/tool argument) is only a fallback.
    const perRequestResolver: IdentityResolver = (inBandToken) => baseResolver(headerToken ?? inBandToken);

    try {
      const { server } = createMcpServer(backend, perRequestResolver, given?.serverInfo);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        // Both return promises; a rejection left unhandled would take the whole process down.
        void Promise.allSettled([transport.close(), server.close()]);
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
export function startHttpServer(port: number, opts: HttpTransportOptions): Promise<RunningHttpServer> {
  const app = createHttpApp(opts);
  return new Promise<RunningHttpServer>((resolve) => {
    const server = app.listen(port, () => {
      const boundPort = typeof server.address() === "object" ? (server.address() as { port: number }).port : port;
      console.log(`TypeS MCP server (Streamable HTTP) listening on http://localhost:${boundPort}/mcp`);
      resolve({ port: boundPort, close: () => new Promise<void>((res) => server.close(() => res())) });
    });
  });
}
