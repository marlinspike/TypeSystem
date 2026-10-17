#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { SURFACES, type SurfaceKey } from "./catalog.js";
import { coverageMarkdown } from "./coverage.js";
import { startGuide } from "./guide.js";
import { DEFAULT_CONFIG, SAMPLE_CONFIGS, describeModels, discoverModels, renderModels } from "./models.js";
import { ROOT, Stack, preflight } from "./stack.js";

const USAGE = `typesys-showcase: the TypeSystem developer showcase

  start [--only demo,recall,...]   start every service, surface and the guide (default)
  models [file] [--discover]       the model configurations: providers, models, simulated or real
  coverage [--write]               the coverage matrix (docs/showcase/coverage.md)
  check                            what start needs, without starting anything`;

async function start(only?: SurfaceKey[]): Promise<void> {
  const keys = only ?? (Object.keys(SURFACES) as SurfaceKey[]);
  const pre = await preflight(keys);
  if (!pre.ok) {
    console.error(["The showcase cannot start:", ...pre.problems.map((p) => `  ${p}`), "Run:", ...pre.fixes.map((f) => `  ${f}`)].join("\n"));
    process.exitCode = 1;
    return;
  }
  const log = (line: string) => console.log(line);
  const stack = new Stack(keys);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    console.log("stopping");
    await stack.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  console.log("starting the services, the simulated model and the surfaces");
  await stack.start(log);
  const guide = await startGuide(stack, SURFACES.guide.port, log);
  console.log(`\nShowcase guide: ${guide.url}\n(The identities and classifications are demonstration configuration, not an accredited deployment. Ctrl-C stops everything.)`);
}

async function main(argv: string[]): Promise<void> {
  const [command = "start", ...rest] = argv;
  if (command === "start") {
    const i = rest.indexOf("--only");
    const only = i >= 0 ? (rest[i + 1] ?? "").split(",").filter(Boolean) : undefined;
    const unknown = only?.filter((k) => !(k in SURFACES));
    if (unknown?.length) throw new Error(`unknown surface ${unknown.join(", ")}; one of ${Object.keys(SURFACES).join(", ")}`);
    return start(only ? (["guide", ...only] as SurfaceKey[]) : undefined);
  }
  if (command === "models") {
    const files = rest.filter((a) => !a.startsWith("--"));
    for (const file of files.length ? files : [process.env.TYPESYS_LLM_CONFIG ?? DEFAULT_CONFIG, ...SAMPLE_CONFIGS]) {
      console.log(renderModels(describeModels(file)).join("\n"));
      if (rest.includes("--discover")) for (const line of await discoverModels(file)) console.log(`  ${line}`);
    }
    return;
  }
  if (command === "coverage") {
    const md = coverageMarkdown();
    if (rest.includes("--write")) {
      writeFileSync(path.join(ROOT, "docs/showcase/coverage.md"), md);
      console.log("wrote docs/showcase/coverage.md");
    } else process.stdout.write(md);
    return;
  }
  if (command === "check") {
    const pre = await preflight();
    console.log(pre.ok ? "ready: npm run showcase" : [...pre.problems, "Run:", ...pre.fixes.map((f) => `  ${f}`)].join("\n"));
    if (!pre.ok) process.exitCode = 1;
    return;
  }
  console.log(USAGE);
  if (command !== "help" && command !== "--help") process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
