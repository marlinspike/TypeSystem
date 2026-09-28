import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { recordOperationDuration } from "./metrics.js";

/**
 * `@typesys/core` depends only on `@opentelemetry/api` (see ADR-0017) —
 * the zero-behavior interface package. `trace.getTracer` returns a no-op
 * tracer unless the embedding application registers a real SDK
 * (`NodeTracerProvider`, an exporter, etc). Every span created here is
 * free and inert until that happens; this module never imports an SDK.
 */
const tracer = trace.getTracer("@typesys/core");

export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** `withSpan` + the matching `typesys.operation.duration` histogram observation, one call site per instrumented method. */
export async function instrumentOperation<T>(
  operationName: string,
  typeName: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    return await withSpan(operationName, { "typesys.type_name": typeName, ...attributes }, fn);
  } finally {
    recordOperationDuration(operationName, typeName, Date.now() - start);
  }
}

/** Best-effort: annotate whichever span is currently active (if any) — used by the cache-aware resolution paths. */
export function annotateActiveSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}
