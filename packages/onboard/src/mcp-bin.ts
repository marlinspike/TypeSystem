#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOnboardServer } from "./mcp.js";

/** `typesys-onboard-mcp [root]`: the onboarding tools over stdio, confined to `root` (default: the working directory). */
const root = process.argv[2] ?? process.cwd();
await createOnboardServer(root).connect(new StdioServerTransport());
