#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEngineerServer } from "./mcp.js";

/** `typesys-engineer-mcp [root]`: the engineer tools over stdio, confined to `root` (default: the working directory). */
const root = process.argv[2] ?? process.cwd();
await createEngineerServer(root).connect(new StdioServerTransport());
