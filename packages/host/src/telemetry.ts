import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { context, metrics, trace } from "@opentelemetry/api";
import type { Deployment } from "./deployment.js";

/** What `runtime.telemetry` resolved to: where spans and metrics are sent (ADR-0121). */
export interface TelemetryConfig {
  /** The OTLP/HTTP endpoint's base URL (`http://otel-collector:4318`): traces go to `/v1/traces`, metrics to `/v1/metrics`. */
  readonly endpoint: string;
  readonly serviceName: string;
  readonly metricsIntervalMs: number;
}

/** A started exporter, flushed and stopped with the server. */
export interface Telemetry {
  shutdown(): Promise<void>;
}

/**
 * Registers OpenTelemetry's SDK with OTLP/HTTP exporters (ADR-0121). Every
 * runtime call is already instrumented against the OpenTelemetry API
 * (ADR-0017), which records nothing until a provider is registered; this is
 * that registration, made by the deployment instead of by code. Spans carry
 * what the runtime puts on them, which is never a value it read.
 */
export async function startTelemetry(config: TelemetryConfig, deployment: Deployment, build: string): Promise<Telemetry> {
  // Loaded only when a deployment names a collector: the SDK and its exporters add a tenth of a second to every start otherwise.
  const [{ AsyncHooksContextManager }, { OTLPMetricExporter }, { OTLPTraceExporter }, { resourceFromAttributes }, { MeterProvider, PeriodicExportingMetricReader }, { BasicTracerProvider, BatchSpanProcessor }] = await Promise.all([
    import("@opentelemetry/context-async-hooks"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/sdk-trace-base")
  ]);
  const resource = resourceFromAttributes({ "service.name": config.serviceName, "service.version": build, "typesys.deployment": deployment.name });
  const base = config.endpoint.replace(/\/+$/, "");
  const contextManager = new AsyncHooksContextManager().enable();
  context.setGlobalContextManager(contextManager);
  const tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces` }))] });
  trace.setGlobalTracerProvider(tracerProvider);
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }), exportIntervalMillis: config.metricsIntervalMs })]
  });
  metrics.setGlobalMeterProvider(meterProvider);
  return {
    async shutdown() {
      // What is buffered is sent before the process exits; a collector that is down must not hold the shutdown.
      await Promise.race([Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]), new Promise((r) => setTimeout(r, 5000).unref())]);
      trace.disable();
      metrics.disable();
      context.disable();
    }
  };
}

/**
 * A request's path with every value taken out (ADR-0121): object ids and
 * workflow run ids become `:id`, and any segment long enough to be data
 * becomes `:value`. Type, relationship, property, Action and workflow names
 * are the model, and stay. The query string is never kept.
 */
export function routeOf(path: string): string {
  const segments = path.split("?")[0]!.split("/");
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const prev = segments[i - 1];
    const prev2 = segments[i - 2];
    if (prev2 === "objects" && i >= 3) out.push(":id");
    else if (prev === "workflow-runs") out.push(":id");
    else if (seg.length > 64) out.push(":value");
    else out.push(seg);
  }
  return out.join("/") || "/";
}

/** One JSON line per request: what an operator reads, and what a log pipeline indexes. Never a value, a token or a query. */
export interface RequestLogLine {
  readonly ts: string;
  readonly level: "info" | "warn" | "error";
  readonly event: "http";
  readonly deployment: string;
  readonly build: string;
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly ms: number;
}

/**
 * Logs each request once it is answered (ADR-0121), and gives it an id: the
 * caller's `X-Request-Id` when it is a plain token, else a new one, echoed in
 * the response so a caller's report can be found in the log.
 */
export function requestLog(deployment: string, build: string, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    const given = req.header("x-request-id");
    const requestId = given && /^[A-Za-z0-9._-]{1,64}$/.test(given) ? given : randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.on("finish", () => {
      // Health checks are polled every few seconds: logging each would bury everything else.
      if ((req.path === "/healthz" || req.path === "/readyz") && res.statusCode < 400) return;
      const line: RequestLogLine = {
        ts: new Date().toISOString(),
        level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        event: "http",
        deployment,
        build,
        requestId,
        method: req.method,
        route: routeOf(req.originalUrl),
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10
      };
      write(JSON.stringify(line));
    });
    next();
  };
}
