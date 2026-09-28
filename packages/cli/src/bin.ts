#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SemanticRegistry, InMemoryRegistryStore, coreManifest, coreTraits, registerDomain, type BindingRegistry } from "@typesys/core";
import { registerYamlTypesFromDirectory } from "./yaml-loader.js";
import { generateModule } from "./codegen.js";
import { scaffoldDomain } from "./scaffold.js";

function usage(): void {
  console.log(`typesys — TypeS declarative authoring CLI

Usage:
  typesys init <dir> [--name <domainName>] [--force] [--json]
  typesys validate <dir> [--bindings <module.js>] [--json]
  typesys generate-types <dir> [--bindings <module.js>] [--out <file.ts>]

<dir> is a directory of .yaml/.yml type files, loaded in alphabetical
order (name files so base types sort before subtypes that extend them).
core's own Types (Party/Person/Organization/Location/Asset/Event) and
traits are always pre-registered, so \`extends: core.Asset\` etc. just works.

  init          Scaffold a starter domain directory: one example Type,
                one bindings module stub, one README. --name sets the
                domain prefix (default: the directory's basename).
  validate      Register every .yaml file and report success/failure —
                a CI gate for a PR that only touches YAML.
  generate-types Emit one TypeScript interface per registered Type.

--bindings points at a JS module whose default export (or module.exports)
  is a BindingRegistry ({ computed: {...}, preconditions: {...} }) —
  needed only if your Types declare computed properties or persisted
  preconditions (see docs/adr/0015-postgres-registry-store.md — same seam).
--json prints a single machine-readable JSON object to stdout instead of
  human-formatted text — {"ok": true, ...} on success, {"ok": false,
  "error": "..."} on failure — for CI or an agent to parse directly rather
  than scraping prose. Exit code is 0/1 either way.
`);
}

async function loadBindings(modulePath: string | undefined): Promise<BindingRegistry> {
  if (!modulePath) return { computed: {}, preconditions: {} };
  const resolved = path.resolve(process.cwd(), modulePath);
  const mod = (await import(pathToFileURL(resolved).href)) as { default?: BindingRegistry } & Partial<BindingRegistry>;
  return mod.default ?? { computed: mod.computed ?? {}, preconditions: mod.preconditions ?? {} };
}

interface ParsedArgs {
  command?: string;
  dir?: string;
  bindings?: string;
  out?: string;
  name?: string;
  json: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, dir, ...rest] = argv;
  const result: ParsedArgs = { command, dir, json: false, force: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--bindings") result.bindings = rest[++i];
    else if (rest[i] === "--out") result.out = rest[++i];
    else if (rest[i] === "--name") result.name = rest[++i];
    else if (rest[i] === "--json") result.json = true;
    else if (rest[i] === "--force") result.force = true;
  }
  return result;
}

async function buildRegistryFromDir(dir: string, bindings: BindingRegistry): Promise<SemanticRegistry> {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registerDomain(registry, coreManifest);
  await registerYamlTypesFromDirectory(registry, dir, {
    traitCatalog: coreTraits,
    computedImplementations: bindings.computed
  });
  return registry;
}

function printResult(json: boolean, ok: boolean, payload: Record<string, unknown>, humanLines: string[]): void {
  if (json) {
    console.log(JSON.stringify({ ok, ...payload }));
  } else {
    for (const line of humanLines) (ok ? console.log : console.error)(line);
  }
  process.exitCode = ok ? 0 : 1;
}

async function main(): Promise<void> {
  const { command, dir, bindings: bindingsPath, out, name, json, force } = parseArgs(process.argv.slice(2));

  if (command === "init") {
    if (!dir) {
      usage();
      process.exitCode = 1;
      return;
    }
    const domainName = name ?? path.basename(path.resolve(dir));
    try {
      const result = await scaffoldDomain(dir, domainName, force);
      printResult(json, true, { dir: result.dir, createdFiles: result.createdFiles }, [
        `Scaffolded "${domainName}" in ${result.dir}:`,
        ...result.createdFiles.map((f) => `  ${f}`),
        "",
        `Next: npx typesys validate ${dir} --bindings ${path.join(dir, "bindings.mjs")}`
      ]);
    } catch (err) {
      printResult(json, false, { error: err instanceof Error ? err.message : String(err) }, [
        `FAIL — ${err instanceof Error ? err.message : String(err)}`
      ]);
    }
    return;
  }

  if (command === "validate") {
    if (!dir) {
      usage();
      process.exitCode = 1;
      return;
    }
    try {
      const registry = await buildRegistryFromDir(dir, await loadBindings(bindingsPath));
      const types = (await registry.listTypes()).filter((t) => !t.name.startsWith("core."));
      const typeSummaries = types.map((t) => ({ name: t.name, version: t.version }));
      printResult(json, true, { dir, types: typeSummaries }, [
        `OK — ${types.length} type(s) registered from ${dir}:`,
        ...types.map((t) => `  ${t.name}@${t.version}`)
      ]);
    } catch (err) {
      printResult(json, false, { error: err instanceof Error ? err.message : String(err) }, [
        `FAIL — ${err instanceof Error ? err.message : String(err)}`
      ]);
    }
    return;
  }

  if (command === "generate-types") {
    if (!dir) {
      usage();
      process.exitCode = 1;
      return;
    }
    const registry = await buildRegistryFromDir(dir, await loadBindings(bindingsPath));
    const code = await generateModule(registry);
    if (out) {
      await writeFile(out, code, "utf8");
      console.log(`Wrote ${out}`);
    } else {
      process.stdout.write(code);
    }
    return;
  }

  usage();
  process.exitCode = command ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
