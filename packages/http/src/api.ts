import express, { type Express, type NextFunction, type Request, type Response, type Router } from "express";
import {
  InvalidInputError,
  NotFoundError,
  describeModel,
  summarizeAction,
  type Identity,
  type IdentityResolver,
  type SemanticAggregateQuery,
  type SemanticQuery,
  type SemanticRegistry,
  type SemanticRuntime
} from "@typesys/core";
import { discover, validateQuery } from "@typesys/devkit";
import type { WorkflowEngine } from "@typesys/workflow";
import { LOCAL_HOSTS, bearerToken, originGuard } from "./guard.js";
import { openApiDocument } from "./openapi.js";
import { bodyProblem, notFound, sendProblem, toProblem, unauthorized } from "./problems.js";

export interface ApiOptions {
  /** What every request is served from: a registry and the runtime over it (what `buildRuntime` returns). */
  readonly backend: { readonly registry: SemanticRegistry; readonly runtime: SemanticRuntime };
  /** Bearer token to `Identity`, on every request. Required: the API assumes no identity of its own (ADR-0050). */
  readonly identityResolver: IdentityResolver;
  /** Serves the workflow routes when given (ADR-0057). */
  readonly workflows?: WorkflowEngine;
  /** Told of every 500 with the error itself, which the response never carries. Default: `console.error`. */
  readonly onError?: (err: unknown, req: Request) => void;
  /** The `info` of the OpenAPI document. */
  readonly info?: { readonly title?: string; readonly version?: string };
}

export interface ApiAppOptions extends ApiOptions {
  /** Host names the app answers to. Default: this machine only. `"*"` turns the check off, for a proxy that enforces it. */
  readonly allowedHosts?: readonly string[] | "*";
  /** Browser origins allowed. Default: `http(s)://` on any allowed host; none when `allowedHosts` is `"*"`. */
  readonly allowedOrigins?: readonly string[];
}

type Handler = (req: Request, identity: Identity) => Promise<unknown>;

/** The API answers only JSON: never sniffed as something else, never framed. */
function apiHardening(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
}

const param = (req: Request, name: string): string => String(req.params[name]);
const body = <T>(req: Request): T => (req.body ?? {}) as T;

/**
 * The governed REST API (ADR-0058). Every route resolves the caller from the
 * bearer token and makes one runtime call as them, so it adds no decision of
 * its own: what the runtime refuses, the API refuses, with an RFC 9457
 * problem whose `code` a client can branch on. Execution plans are returned
 * without the authorization plan, as over MCP (ADR-0054).
 */
export function createApiRouter(opts: ApiOptions): Router {
  if (!opts?.backend?.registry || !opts.backend.runtime) throw new TypeError("createApiRouter needs a backend: { registry, runtime }");
  if (typeof opts.identityResolver !== "function") throw new TypeError("createApiRouter needs an identity resolver; it assumes no identity of its own");
  const { registry, runtime } = opts.backend;
  const onError = opts.onError ?? ((err: unknown) => console.error("TypeSys API error:", err));
  const router = express.Router();
  router.use(apiHardening);
  router.use(express.json({ limit: "256kb" }));

  const route = (status: number, handler: Handler) => async (req: Request, res: Response) => {
    let identity: Identity;
    try {
      identity = await opts.identityResolver(bearerToken(req) ?? null);
    } catch {
      // A token the resolver refuses (expired, bad signature) is the caller's fault, not the server's.
      sendProblem(res.setHeader("WWW-Authenticate", "Bearer"), unauthorized());
      return;
    }
    try {
      res.status(status).json(await handler(req, identity));
    } catch (err) {
      const problem = toProblem(err);
      if (problem.status === 500) onError(err, req);
      sendProblem(res, problem);
    }
  };
  const workflows = (): WorkflowEngine => {
    if (!opts.workflows) throw new NotFoundError("This API serves no workflows");
    return opts.workflows;
  };

  router.get("/me", route(200, async (_req, who) => ({ subjectId: who.subjectId, roles: who.roles, ...(who.clearance ? { clearance: who.clearance } : {}) })));
  router.get("/model", route(200, async () => describeModel(registry)));
  router.get("/openapi.json", route(200, async () => openApiDocument(await describeModel(registry), { ...opts.info, workflows: opts.workflows !== undefined, queryLimits: runtime.queryLimits })));

  router.post("/query", route(200, (req, who) => runtime.query(body<SemanticQuery>(req), who)));
  router.post("/query/explain", route(200, async (req, who) => (await runtime.explainQuery(body<SemanticQuery>(req), who)).execution));
  router.post("/query/validate", route(200, async (req) => ({ diagnostics: validateQuery(await describeModel(registry), body<{ query?: unknown }>(req).query, runtime.queryLimits) })));
  router.post("/aggregate", route(200, (req, who) => runtime.aggregate(body<SemanticAggregateQuery>(req), who)));
  router.post(
    "/discover",
    route(200, async (req) => {
      const { task, limit } = body<{ task?: unknown; limit?: unknown }>(req);
      return discover(await describeModel(registry), typeof task === "string" ? task : "", { limit: typeof limit === "number" ? Math.min(20, Math.max(1, limit)) : 5 });
    })
  );

  router.get(
    "/objects/:type/:id",
    route(200, (req, who) => runtime.getObject(param(req, "type"), param(req, "id"), who, { includeProvenance: req.query.provenance === "true" }))
  );
  router.get("/objects/:type/:id/related/:relationship", route(200, (req, who) => runtime.getRelationship(param(req, "type"), param(req, "id"), param(req, "relationship"), who)));
  router.get("/objects/:type/:id/provenance/:property", route(200, (req, who) => runtime.getProvenance(param(req, "type"), param(req, "id"), param(req, "property"), who)));

  router.get(
    "/types/:type/actions",
    route(200, async (req, who) => {
      const objectId = typeof req.query.objectId === "string" ? req.query.objectId : undefined;
      return (await runtime.listActions(param(req, "type"), who, objectId === undefined ? {} : { objectId })).map(summarizeAction);
    })
  );
  router.post("/actions/:name/preview", route(200, (req, who) => runtime.previewAction(param(req, "name"), req.body, who)));
  router.post("/actions/:name/invoke", route(200, async (req, who) => ({ result: (await runtime.invokeAction(param(req, "name"), req.body, who)) ?? null })));

  router.post("/workflows/:name/runs", route(201, (req, who) => workflows().start(param(req, "name"), body<{ input?: unknown }>(req).input, who)));
  router.get("/workflow-runs/:id", route(200, (req, who) => workflows().status(param(req, "id"), who)));
  router.get("/workflow-runs/:id/outputs", route(200, (req, who) => workflows().outputs(param(req, "id"), who)));
  router.get("/workflow-runs/:id/approval", route(200, (req, who) => workflows().pendingApproval(param(req, "id"), who)));
  router.get("/workflow-approvals", route(200, (_req, who) => workflows().approvalsFor(who)));
  router.post(
    "/workflow-runs/:id/approvals/:step",
    route(200, (req, who) => {
      const { approved, comment } = body<{ approved?: unknown; comment?: unknown }>(req);
      if (typeof approved !== "boolean") throw new InvalidInputError("`approved` must be true or false");
      return workflows().approve(param(req, "id"), param(req, "step"), who, { approved, ...(typeof comment === "string" ? { comment } : {}) });
    })
  );
  // The caller's own, freshly resolved identity is what re-authorizes (ADR-0065): no credential travels in the body.
  router.post("/workflow-runs/:id/reauthorize", route(200, (req, who) => workflows().reauthorize(param(req, "id"), who)));
  router.post(
    "/workflow-runs/:id/cancel",
    route(200, (req, who) => {
      const { reason } = (req.body ?? {}) as { reason?: unknown };
      return workflows().cancel(param(req, "id"), who, typeof reason === "string" ? reason : undefined);
    })
  );

  // Anything else under the API, and a body that never parsed, is a problem too: never Express's HTML page, its stack or the server's paths.
  router.use((_req: Request, res: Response) => sendProblem(res, notFound()));
  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const problem = bodyProblem(err) ?? toProblem(err);
    if (problem.status === 500) onError(err, req);
    sendProblem(res, problem);
  });

  return router;
}

/** The API as an app: Host and Origin checks first, then `/healthz`, `/readyz`, and the API under `/api`. */
export function createApiApp(opts: ApiAppOptions): Express {
  const app = express();
  app.use(
    originGuard(opts.allowedHosts ?? LOCAL_HOSTS, opts.allowedOrigins, (res, message) =>
      res
        .status(403)
        .type("application/problem+json")
        .send(JSON.stringify({ type: "https://typesys.dev/problems/forbidden", title: "Not authorized", status: 403, code: "forbidden", detail: message }))
    )
  );
  app.get("/healthz", (_req, res) => void res.json({ status: "ok" }));
  app.get("/readyz", async (_req, res) => {
    try {
      await opts.backend.registry.listActions();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not_ready" });
    }
  });
  app.use("/api", createApiRouter(opts));
  return app;
}
