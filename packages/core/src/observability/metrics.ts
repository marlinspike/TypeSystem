import { metrics, type MeterProvider } from "@opentelemetry/api";

/**
 * Same no-op-by-default contract as tracing.ts (see ADR-0017) — `@opentelemetry/api` only.
 * Unlike a tracer, a meter taken before a provider is registered stays a no-op
 * for good (the API has no proxy meter), so the instruments are made again
 * whenever the global provider changes: an SDK a server registers after this
 * module loaded, as the generic server does from its deployment (ADR-0121),
 * still receives every measurement.
 */
function makeInstruments() {
  const meter = metrics.getMeter("@typesys/core");
  return {
    policyDecisions: meter.createCounter("typesys.policy.decisions", {
      description: "Policy engine decisions, labeled by outcome. Mirrors, never replaces, the durable audit log."
    }),
    policyFaults: meter.createCounter("typesys.policy.faults", {
      description: "Parts of policy rules that failed to evaluate (ADR-0043), whatever the decision they were part of."
    }),
    cacheRequests: meter.createCounter("typesys.cache.requests", {
      description: "Cache lookups performed by cache-aware resolution paths (ADR-0016), labeled by result."
    }),
    planDefects: meter.createCounter("typesys.authz.plan.defects", {
      description: "Authorization-plan defects (ADR-0038): a planner that failed, or an object an exact plan admitted that the policy denied."
    }),
    operationDuration: meter.createHistogram("typesys.operation.duration", {
      description: "Wall-clock duration of a traced SemanticRuntime operation.",
      unit: "ms"
    })
  };
}

let current: { provider: MeterProvider; instruments: ReturnType<typeof makeInstruments> } | undefined;

function instruments(): ReturnType<typeof makeInstruments> {
  const provider = metrics.getMeterProvider();
  if (current?.provider !== provider) current = { provider, instruments: makeInstruments() };
  return current.instruments;
}

export function recordPolicyDecision(decision: "allow" | "deny"): void {
  instruments().policyDecisions.add(1, { decision });
}

/** `bypass`: a cached-mode read of sensitive data that skipped a cache that isn't confidential (ADR-0036). */
export function recordPolicyFaults(count: number): void {
  instruments().policyFaults.add(count);
}

export function recordCacheResult(result: "hit" | "miss" | "bypass"): void {
  instruments().cacheRequests.add(1, { result });
}

export function recordPlanDefect(defect: "planner-failed" | "admitted-denied"): void {
  instruments().planDefects.add(1, { defect });
}

export function recordOperationDuration(operation: string, typeName: string, durationMs: number): void {
  instruments().operationDuration.record(durationMs, { operation, type_name: typeName });
}
