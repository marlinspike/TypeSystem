/**
 * Library barrel — importable by other processes (e.g. the demo web app)
 * that want to embed the MCP server without starting a transport as a side
 * effect of import. It names no domain (ADR-0050): give it any registry and
 * runtime, and an identity resolver. The demo's stdio and HTTP entry points
 * live in `@typesys/demo-web`.
 */
export * from "./server.js";
export type { McpBackend, McpServerInfo } from "./backend.js";
export * from "./resources.js";
export * from "./tools.js";
export * from "./auth.js";
export * from "./resource-uri.js";
export * from "./http-transport.js";
