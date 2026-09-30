import { metrics } from "@opentelemetry/api";

/** Same no-op-by-default contract as tracing.ts (see ADR-0017) — `@opentelemetry/api` only. */
const meter = metrics.getMeter("@typesys/core");

const policyDecisionsCounter = meter.createCounter("typesys.policy.decisions", {
  description: "Policy engine decisions, labeled by outcome. Mirrors, never replaces, the durable audit log."
});

const cacheRequestsCounter = meter.createCounter("typesys.cache.requests", {
  description: "Cache lookups performed by cache-aware resolution paths (ADR-0016), labeled by result."
});

const planDefectsCounter = meter.createCounter("typesys.authz.plan.defects", {
  description: "Authorization-plan defects (ADR-0038): a planner that failed, or an object an exact plan admitted that the policy denied."
});

const operationDurationHistogram = meter.createHistogram("typesys.operation.duration", {
  description: "Wall-clock duration of a traced SemanticRuntime operation.",
  unit: "ms"
});

export function recordPolicyDecision(decision: "allow" | "deny"): void {
  policyDecisionsCounter.add(1, { decision });
}

/** `bypass`: a cached-mode read of sensitive data that skipped a cache that isn't confidential (ADR-0036). */
export function recordCacheResult(result: "hit" | "miss" | "bypass"): void {
  cacheRequestsCounter.add(1, { result });
}

export function recordPlanDefect(defect: "planner-failed" | "admitted-denied"): void {
  planDefectsCounter.add(1, { defect });
}

export function recordOperationDuration(operation: string, typeName: string, durationMs: number): void {
  operationDurationHistogram.record(durationMs, { operation, type_name: typeName });
}
