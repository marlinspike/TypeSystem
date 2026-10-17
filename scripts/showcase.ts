/**
 * `npm run showcase`: brings the build up to date, then starts the showcase
 * (packages/showcase). Every step is incremental, so on a built checkout
 * this adds a few seconds; on a fresh pull it builds what the pull changed.
 * `--no-build` skips it. Arguments are passed on: `npm run showcase -- models`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => path.join(ROOT, "node_modules/.bin", name);

function fail(lines: string[]): never {
  console.error(lines.join("\n"));
  process.exit(1);
}

// The repository is npm workspaces: another package manager installs the dependencies but does not link the workspace packages.
const agent = process.env.npm_config_user_agent ?? "";
if (agent && !agent.startsWith("npm/")) {
  fail([`This repository uses npm workspaces, which ${agent.split("/")[0]} does not link. Run:`, "  npm install", "  npm run showcase"]);
}
if (!existsSync(path.join(ROOT, "node_modules/@typesys/core"))) {
  fail(["The workspace packages are not installed. Run:", "  npm install", "  npm run showcase"]);
}

const args = process.argv.slice(2);
const build = !args.includes("--no-build");
const passOn = args.filter((a) => a !== "--no-build");

if (build) {
  const steps: { what: string; command: string; args: string[] }[] = [
    { what: "packages", command: bin("tsc"), args: ["-b"] },
    { what: "browser clients", command: bin("tsx"), args: ["scripts/build-clients.ts"] },
    { what: "Cold Chain Command", command: process.execPath, args: ["packages/compiler/dist/bin.js", "build", "examples/apps/cold-chain"] },
    { what: "Recall Response", command: process.execPath, args: ["packages/compiler/dist/bin.js", "build", "examples/apps/recall-response"] }
  ];
  for (const step of steps) {
    process.stdout.write(`building ${step.what}… `);
    const started = Date.now();
    const run = spawnSync(step.command, step.args, { cwd: ROOT, encoding: "utf8" });
    if (run.status !== 0) {
      console.log("failed");
      fail([`${[path.basename(step.command), ...step.args].join(" ")} failed:`, (run.stdout + run.stderr).trim() || String(run.error ?? `exit ${run.status}`)]);
    }
    console.log(`done (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }
}

const child = spawn(process.execPath, [path.join(ROOT, "packages/showcase/dist/bin.js"), ...passOn], { cwd: ROOT, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
