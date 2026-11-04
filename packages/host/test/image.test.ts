import { describe, it, expect } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const serveJs = path.join(root, "packages/host/dist/serve.js");

describe("the image's server (ADR-0120)", () => {
  // `node serve.js` with a deployment whose extension imports @typesys/host once waited on itself forever (a top-level
  // await in the module the extension imports). The image runs exactly this command.
  it.skipIf(!existsSync(serveJs))("starts as the image starts it, on a deployment whose extension imports @typesys/host", () => {
    const out = execFileSync(process.execPath, [serveJs, "deployments/airforce.deployment.json", "--check"], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, TYPESYS_PACKS_DIR: path.join(root, "packs") } });
    expect(out).toMatch(/^airforce builds: sha256:[0-9a-f]{64}$/m);
  });

  it.skipIf(!existsSync(serveJs))("runs the migrate step as the image runs it", () => {
    const out = execFileSync(process.execPath, [serveJs, "migrate"], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, TYPESYS_DEPLOYMENT: "deployments/airforce.deployment.json" } });
    expect(out).toContain("keeps no state in Postgres: nothing to migrate");
  });

  it("copies everything npm run build reads, and keeps only what runs", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const build = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: { build: string } }).scripts.build;
    // The build bundles the browser clients with a script outside packages/.
    expect(build).toContain("scripts/build-clients.ts");
    expect(dockerfile).toMatch(/^COPY scripts \.\/scripts$/m);
    expect(dockerfile).toMatch(/npm prune --omit=dev/);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^CMD \["node", "packages\/host\/dist\/serve\.js"\]$/m);
    // Never built on a pull request: the image workflow is started by hand only.
    const workflow = readFileSync(path.join(root, ".github/workflows/image.yml"), "utf8");
    const triggers = /^on:\n((?: .*\n)+)/m.exec(workflow)?.[1] ?? "";
    expect(triggers.match(/^ {2}[a-z_]+:/gm)).toEqual(["  workflow_dispatch:"]);
  });
});
