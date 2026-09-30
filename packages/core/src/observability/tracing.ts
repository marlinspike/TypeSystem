import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { recordOperationDuration } from "./metrics.js";

/**
 * `@typesys/core` depends only on `@opentelemetry/api` (see ADR-0017) —
 * the zero-behavior interface package. `trace.getTracer` returns a no-op
 * tracer unless the embedding application registers a real SDK
 * (`NodeTracerProvider`, an exporter, etc). Every span created here is
 * free and inert until that happens; this module never imports an SDK.
 */
// Looked up per span, not once at import: a tracer that has reached a provider stays bound to it, so an SDK
// registered in its place later would never see this module's spans.
const tracer = () => trace.getTracer("@typesys/core");

/** How a span records a failure: the error as thrown, or — when messages could carry identifiers (ADR-0047) — its class name alone. */
export interface SpanErrorOptions {
  redactErrors?: boolean;
}

/** An error's `name` is recorded only if it looks like a class name; anyone can set it to anything. */
const ERROR_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, options: SpanErrorOptions = {}): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      if (options.redactErrors) {
        // A runtime message names objects and subjects; the class name says what kind of failure it was.
        const kind = err instanceof Error && ERROR_CLASS.test(err.name) ? err.name : "Error";
        span.recordException({ name: kind, message: kind });
        span.setStatus({ code: SpanStatusCode.ERROR, message: kind });
      } else {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      }
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
  fn: (span: Span) => Promise<T>,
  options: SpanErrorOptions = {}
): Promise<T> {
  const start = Date.now();
  try {
    return await withSpan(operationName, { "typesys.type_name": typeName, ...attributes }, fn, options);
  } finally {
    recordOperationDuration(operationName, typeName, Date.now() - start);
  }
}

/** Best-effort: annotate whichever span is currently active (if any) — used by the cache-aware resolution paths. */
export function annotateActiveSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}
