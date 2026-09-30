import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AuthorizationError,
  InMemoryRateLimiter,
  InvalidInputError,
  NotFoundError,
  PreconditionFailedError,
  RateLimitExceededError,
  buildRuntime,
  coreManifest,
  type Adapter,
  type Identity,
  type RateLimiter,
  type ResiliencePolicy,
  type SemanticAggregateQuery,
  type SemanticQuery,
  type TypeDefinition
} from "@typesys/core";
import { airforceManifest, airforcePolicyRules, buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { buildHospitalTestbed, hospitalDemoIdentities, hospitalManifest, hospitalPolicyRules } from "@typesys/domain-hospital";
import { createServer as createMcpServer } from "@typesys/mcp-server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Deliberately low, so the per-request concurrency budget (ADR-0025) is visible: a query with
 * nested includes fans out to dozens of adapter calls, but never more than this many at once.
 */
const DEMO_MAX_CONCURRENCY = 4;

/**
 * Timeout + idempotent-retry + circuit breaker applied to every adapter call (ADR-0026). The demo
 * backends are fast, so the timeout won't fire in normal use — this is here so the policy is a live
 * part of the runtime (and shows up in the Guardrails config), not just words in an ADR.
 */
const DEMO_RESILIENCE: ResiliencePolicy = {
  callTimeoutMs: 2000,
  retry: { maxAttempts: 3, baseDelayMs: 25, maxDelayMs: 250 },
  circuitBreaker: { failureThreshold: 5, cooldownMs: 10_000 }
};

/**
 * Rate limiting applies to one dedicated identity, so the burst demo can exhaust a budget without
 * throttling the identities you're clicking around as.
 */
const BURST_IDENTITY: Identity = { subjectId: "demo-burst-tester", roles: ["maintainer"], attributes: {} };
const BURST_LIMIT = { capacity: 20, refillPerSecond: 5 };

const IDENTITIES = {
  maintainer: { identity: demoIdentities.maintainer, domain: "airforce", token: "demo-maintainer-token" },
  viewer: { identity: demoIdentities.viewer, domain: "airforce", token: "demo-viewer-token" },
  clinician: { identity: hospitalDemoIdentities.clinician, domain: "hospital", token: "demo-clinician-token" },
  otherClinician: { identity: hospitalDemoIdentities.otherClinician, domain: "hospital", token: "demo-clinician-b-token" },
  patient: { identity: hospitalDemoIdentities.patient, domain: "hospital", token: "demo-patient-token" },
  anonymous: { identity: demoIdentities.anonymous, domain: "none", token: "" }
} as const;
type IdentityKey = keyof typeof IDENTITIES;

function resolveIdentity(key: unknown): Identity {
  return typeof key === "string" && key in IDENTITIES ? IDENTITIES[key as IdentityKey].identity : demoIdentities.anonymous;
}

// ---------------------------------------------------------------------------
// Per-request adapter statistics
// ---------------------------------------------------------------------------

interface RequestStats {
  calls: Record<string, number>;
  inFlight: number;
  peakInFlight: number;
  startedAt: number;
}

/** One stats record per HTTP request, so concurrent requests from the browser don't mix their numbers. */
const requestStats = new AsyncLocalStorage<RequestStats>();

/**
 * Wraps an adapter so every call is counted against the current HTTP request's stats. The
 * runtime wraps this again in its own concurrency gate, so `peakInFlight` shows the budget at work.
 */
function tracked<A extends Adapter>(adapter: A): A {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const stats = requestStats.getStore();
        if (!stats) return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        stats.calls[target.dataSourceId] = (stats.calls[target.dataSourceId] ?? 0) + 1;
        stats.inFlight++;
        stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          stats.inFlight--;
        }
      };
    }
  });
}

/** Sends JSON with this request's adapter stats in an `X-TypeS-Stats` header, read by the status bar. */
function sendJson(res: Response, status: number, body: unknown): void {
  const stats = requestStats.getStore();
  if (stats) {
    res.setHeader(
      "X-TypeS-Stats",
      JSON.stringify({ calls: stats.calls, peakInFlight: stats.peakInFlight, durationMs: Math.round(performance.now() - stats.startedAt) })
    );
  }
  res.status(status).json(body);
}

function sendError(res: Response, err: unknown): void {
  const known: [new (...args: never[]) => Error, number][] = [
    [AuthorizationError, 403],
    [NotFoundError, 404],
    [InvalidInputError, 400],
    [PreconditionFailedError, 422],
    [RateLimitExceededError, 429]
  ];
  for (const [ErrorClass, status] of known) {
    if (err instanceof ErrorClass) {
      const reason = err instanceof AuthorizationError ? err.reason : undefined;
      sendJson(res, status, { error: err.name, message: err.message, ...(reason ? { reason } : {}) });
      return;
    }
  }
  console.error(err);
  sendJson(res, 500, { error: "InternalError", message: err instanceof Error ? err.message : String(err) });
}

function describeType(typeDef: TypeDefinition) {
  return {
    name: typeDef.name,
    version: typeDef.version,
    description: typeDef.description,
    extends: typeDef.extends,
    traits: typeDef.traits,
    relationships: typeDef.relationships.map((r) => ({
      name: r.name,
      targetType: r.targetType,
      cardinality: r.cardinality,
      inverseName: r.inverseName,
      dataSourceId: r.resolution.dataSourceId
    })),
    actionNames: typeDef.actionNames,
    computedPropertyNames: typeDef.computedProperties.map((c) => c.name),
    computedProperties: typeDef.computedProperties.map((c) => ({ name: c.name, dependsOn: c.dependsOn, resolutionMode: c.resolutionMode })),
    objectPolicy: typeDef.schema["x-policy"]?.objectPolicy ?? "default-deny",
    propertyPolicies: typeDef.schema["x-policy"]?.propertyPolicies ?? {},
    schema: typeDef.schema
  };
}

async function main(): Promise<void> {
  // Each domain's testbed supplies its seeded adapters; one runtime then hosts both domains —
  // the domain-neutrality claim (ADR-0013), live: two unrelated domains, one registry, one policy engine.
  const airforce = await buildAirforceTestbed();
  const hospital = await buildHospitalTestbed();
  const burstLimiter = new InMemoryRateLimiter(BURST_LIMIT);
  const rateLimiter: RateLimiter = { tryAcquire: (key) => (key === BURST_IDENTITY.subjectId ? burstLimiter.tryAcquire(key) : true) };

  const { registry, runtime, policyEngine } = await buildRuntime({
    manifests: [coreManifest, airforceManifest, hospitalManifest],
    adapters: [tracked(airforce.inMemoryAdapter), tracked(airforce.mockRestAdapter), tracked(hospital.adapter)],
    policyRules: { ...airforcePolicyRules, ...hospitalPolicyRules },
    runtimeOptions: { maxConcurrency: DEMO_MAX_CONCURRENCY, rateLimiter, resilience: DEMO_RESILIENCE }
  });

  // A second, MCP-protocol-shaped front door onto the SAME runtime, so the MCP Console proves
  // identical governance, not just similar-looking code, between the web path and the agent path.
  const tokenIdentities = new Map<string, Identity>(Object.values(IDENTITIES).filter((i) => i.token).map((i) => [i.token, i.identity]));
  const mcpBundle = await createMcpServer(
    { registry, runtime, policyEngine, inMemoryAdapter: airforce.inMemoryAdapter, mockRestAdapter: airforce.mockRestAdapter },
    (token) => Promise.resolve((token && tokenIdentities.get(token)) || demoIdentities.anonymous)
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "typesys-demo-web", version: "0.1.0" });
  await Promise.all([mcpClient.connect(clientTransport), mcpBundle.server.connect(serverTransport)]);

  const app = express();
  app.use(express.json());
  app.use("/api", (_req: Request, _res: Response, next: NextFunction) => {
    requestStats.run({ calls: {}, inFlight: 0, peakInFlight: 0, startedAt: performance.now() }, next);
  });

  /** Wraps a handler so any thrown error becomes a typed JSON error response. */
  const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => sendError(res, err));
  };

  app.get("/api/identities", (_req, res) => {
    sendJson(
      res,
      200,
      Object.entries(IDENTITIES).map(([key, { identity, domain, token }]) => ({ key, domain, token, subjectId: identity.subjectId, roles: identity.roles }))
    );
  });

  app.get("/api/runtime", (_req, res) => {
    sendJson(res, 200, {
      queryLimits: runtime.queryLimits,
      maxConcurrency: DEMO_MAX_CONCURRENCY,
      resilience: DEMO_RESILIENCE,
      rateLimit: { subjectId: BURST_IDENTITY.subjectId, ...BURST_LIMIT },
      dataSources: [airforce.inMemoryAdapter.dataSourceId, airforce.mockRestAdapter.dataSourceId, hospital.adapter.dataSourceId]
    });
  });

  app.get(
    "/api/types",
    handle(async (_req, res) => sendJson(res, 200, (await registry.listTypes()).map(describeType)))
  );

  app.get(
    "/api/types/:name",
    handle(async (req, res) => {
      const typeDef = await registry.getType(req.params.name as string);
      if (!typeDef) throw new NotFoundError(`Unknown type "${req.params.name as string}"`);
      sendJson(res, 200, describeType(typeDef));
    })
  );

  app.get(
    "/api/objects/:typeName",
    handle(async (req, res) => {
      sendJson(res, 200, await runtime.query({ type: req.params.typeName as string }, resolveIdentity(req.query.identity)));
    })
  );

  app.get(
    "/api/objects/:typeName/:objectId",
    handle(async (req, res) => {
      const object = await runtime.getObject(req.params.typeName as string, req.params.objectId as string, resolveIdentity(req.query.identity), {
        includeProvenance: true
      });
      sendJson(res, 200, object);
    })
  );

  app.get(
    "/api/objects/:typeName/:objectId/relationships/:relationshipName",
    handle(async (req, res) => {
      const related = await runtime.getRelationship(
        req.params.typeName as string,
        req.params.objectId as string,
        req.params.relationshipName as string,
        resolveIdentity(req.query.identity)
      );
      sendJson(res, 200, related);
    })
  );

  app.get(
    "/api/objects/:typeName/:objectId/provenance/:propertyPath",
    handle(async (req, res) => {
      const provenance = await runtime.getProvenance(
        req.params.typeName as string,
        req.params.objectId as string,
        req.params.propertyPath as string,
        resolveIdentity(req.query.identity)
      );
      sendJson(res, 200, provenance);
    })
  );

  app.post(
    "/api/query",
    handle(async (req, res) => {
      // Unchecked JSON is fine: SemanticRuntime.query validates it first.
      sendJson(res, 200, await runtime.query(req.body as SemanticQuery, resolveIdentity(req.query.identity)));
    })
  );

  app.post(
    "/api/aggregate",
    handle(async (req, res) => {
      // Grouped aggregation (ADR-0027) through the same governed boundary: SemanticRuntime.aggregate
      // validates the shape and fails closed on a hidden or computed group/aggregation property.
      sendJson(res, 200, await runtime.aggregate(req.body as SemanticAggregateQuery, resolveIdentity(req.query.identity)));
    })
  );

  app.get(
    "/api/actions/:typeName",
    handle(async (req, res) => {
      const actions = await runtime.listActions(req.params.typeName as string, resolveIdentity(req.query.identity));
      sendJson(
        res,
        200,
        actions.map(({ action, authorized }) => ({ name: action.name, description: action.description, inputSchema: action.inputSchema, authorized }))
      );
    })
  );

  app.post(
    "/api/actions/:name/invoke",
    handle(async (req, res) => {
      sendJson(res, 200, { ok: true, result: await runtime.invokeAction(req.params.name as string, req.body, resolveIdentity(req.query.identity)) });
    })
  );

  // Fires `count` reads at once as the rate-limited burst identity, and reports how many the
  // token bucket admitted. The budget refills at BURST_LIMIT.refillPerSecond afterwards.
  app.post(
    "/api/playground/burst",
    handle(async (req, res) => {
      const count = Math.min(200, Math.max(1, Number((req.body as { count?: number }).count ?? 50)));
      const outcomes = await Promise.allSettled(
        Array.from({ length: count }, () => runtime.getObject("airforce.Aircraft", "AF86-0147", BURST_IDENTITY))
      );
      const denied = outcomes.filter((o) => o.status === "rejected" && o.reason instanceof RateLimitExceededError).length;
      const failed = outcomes.filter((o) => o.status === "rejected" && !(o.reason instanceof RateLimitExceededError)).length;
      sendJson(res, 200, { count, allowed: count - denied - failed, denied, failed, ...BURST_LIMIT });
    })
  );

  app.get(
    "/api/audit",
    handle(async (req, res) => {
      const limit = Math.min(500, Number(req.query.limit ?? 300));
      const before = typeof req.query.before === "string" ? req.query.before : undefined;
      sendJson(res, 200, (await registry.listAuditEvents({ limit, before })).items);
    })
  );

  // MCP Console bridge: the exact same tool/resource calls an AI agent would make.
  app.get("/api/mcp/resources", handle(async (_req, res) => sendJson(res, 200, await mcpClient.listResources())));
  app.get("/api/mcp/tools", handle(async (_req, res) => sendJson(res, 200, await mcpClient.listTools())));
  app.post(
    "/api/mcp/resource",
    handle(async (req, res) => {
      const { uri } = req.body as { uri: string };
      sendJson(res, 200, await mcpClient.readResource({ uri }));
    })
  );
  app.post(
    "/api/mcp/tool",
    handle(async (req, res) => {
      const { name, arguments: args } = req.body as { name: string; arguments?: Record<string, unknown> };
      sendJson(res, 200, await mcpClient.callTool({ name, arguments: args }));
    })
  );

  // Liveness/readiness probes (ADR-0029), mirroring the MCP server's — unauthenticated, no stats,
  // and outside the /api tree. `/readyz` proves the registry answers (503 otherwise).
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/readyz", (_req: Request, res: Response) => {
    registry
      .listTypes()
      .then(() => res.status(200).json({ status: "ready" }))
      .catch((err: unknown) => res.status(503).json({ status: "not_ready", error: err instanceof Error ? err.message : String(err) }));
  });

  app.use(express.static(path.join(__dirname, "../public")));

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`TypeS demo running at http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
