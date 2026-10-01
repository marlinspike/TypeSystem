#!/usr/bin/env -S npx tsx
/**
 * Runs the official MCP conformance suite (`@modelcontextprotocol/conformance`,
 * pinned in the root package.json) against the HTTP server, serving the
 * airforce demo on a free port (ADR-0051).
 *
 * Scenarios TypeS is known to fail are listed, each with its reason, in
 * `scripts/mcp-conformance-baseline.yml`. The suite exits non-zero on a
 * failure that isn't listed, and on a listed one that now passes, so the
 * baseline can only shrink deliberately.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { startHttpServer } from "../packages/mcp-server/src/http-transport.js";

const root = resolve(import.meta.dirname, "..");

async function main(): Promise<number> {
  const running = await startHttpServer(0, { backend: await buildAirforceTestbed(), identityResolver: resolveDemoIdentity });
  // The suite writes a results/ directory into its working directory; keep it out of the repository.
  const workDir = mkdtempSync(join(tmpdir(), "typesys-mcp-conformance-"));
  try {
    return await new Promise<number>((done, fail) => {
      const suite = spawn(
        process.execPath,
        [
          join(root, "node_modules/@modelcontextprotocol/conformance/dist/index.js"),
          "server",
          "--url",
          `http://localhost:${running.port}/mcp`,
          "--expected-failures",
          join(root, "scripts/mcp-conformance-baseline.yml")
        ],
        { cwd: workDir, stdio: "inherit" }
      );
      suite.on("error", fail);
      suite.on("exit", (code) => done(code ?? 1));
    });
  } finally {
    await running.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  }
);
