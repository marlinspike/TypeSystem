#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAppMcpServer } from "./mcp.js";

/** `typesys-app-mcp [root]`: the compiler's tools over stdio, confined to `root` (default: the working directory). */
const root = process.argv[2] ?? process.cwd();
await createAppMcpServer(root).connect(new StdioServerTransport());
