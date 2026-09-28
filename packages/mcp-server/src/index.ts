/**
 * Library barrel — importable by other processes (e.g. the demo web app)
 * that want to embed the MCP server without starting a stdio transport as
 * a side effect of import. The stdio CLI entrypoint lives in bin.ts.
 */
export * from "./server.js";
export * from "./resources.js";
export * from "./tools.js";
export * from "./auth.js";
export * from "./resource-uri.js";
export * from "./http-transport.js";
