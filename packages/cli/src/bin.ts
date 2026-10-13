#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SemanticRegistry, InMemoryRegistryStore, coreManifest, coreTraits, describeModel, registerDomain, type BindingRegistry, type ModelDescription } from "@typesys/core";
import { registerYamlTypesFromDirectory } from "./yaml-loader.js";
import { readFile, writeFile } from "node:fs/promises";
import { generateModel } from "@typesys/sdk";
import { diffModels, discover, validateQuery } from "@typesys/devkit";
import { generateModule } from "./codegen.js";
import { scaffoldDomain } from "./scaffold.js";

function usage(): void {
  console.log(`typesys — TypeS declarative authoring CLI

Usage:
  typesys init <dir> [--name <domainName>] [--force] [--json]
  typesys validate <dir> [--bindings <module.js>] [--json]
  typesys generate-types <dir> [--bindings <module.js>] [--out <file.ts>]
  typesys generate-sdk <dir> [--bindings <module.js>] --out <file.ts> [--name <Model>] [--check] [--json]
  typesys describe <dir> [--bindings <module.js>] [--out <model.json>]
  typesys diff <before.json> <after.json> [--json]
  typesys discover <dir> <task words...> [--bindings <module.js>] [--limit <n>] [--json]
  typesys check-query <dir> <query.json> [--bindings <module.js>] [--json]

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
  generate-sdk  Emit the typed client model for @typesys/sdk (ADR-0055):
                \`createClient<Model>(transport)\`. --name names the
                interface (default Model). --check writes nothing and
                fails if --out differs from what the YAML generates now:
                a CI gate against a stale client model.

  describe      Write the model as JSON (ADR-0056): every Type composed, every
                Action, the contract and nothing about enforcement. Commit
                it to compare versions with diff.
  diff          Classify every change between two described models as
                breaking, risky, or compatible, and name each Type or
                Action whose version did not move as far as its changes
                need. Exits 1 on a breaking or under-versioned change.
  discover      The Types and Actions most relevant to a task in words.
  check-query   Check a query JSON file against the model without running
                it, with the name probably meant for each unknown one.

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
  check: boolean;
  limit?: number;
  /** Arguments after `<dir>` that are not flags. */
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, dir, ...rest] = argv;
  const result: ParsedArgs = { command, dir, json: false, force: false, check: false, positionals: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--bindings") result.bindings = rest[++i];
    else if (rest[i] === "--out") result.out = rest[++i];
    else if (rest[i] === "--name") result.name = rest[++i];
    else if (rest[i] === "--json") result.json = true;
    else if (rest[i] === "--force") result.force = true;
    else if (rest[i] === "--check") result.check = true;
    else if (rest[i] === "--limit") result.limit = Number(rest[++i]);
    else result.positionals.push(rest[i]!);
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
  const { command, dir, bindings: bindingsPath, out, name, json, force, check, limit, positionals } = parseArgs(process.argv.slice(2));

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

  if (command === "generate-sdk") {
    if (!dir || !out) {
      usage();
      process.exitCode = 1;
      return;
    }
    try {
      const registry = await buildRegistryFromDir(dir, await loadBindings(bindingsPath));
      const code = generateModel(await describeModel(registry, { prefixes: await domainPrefixes(registry) }), { name: name ?? "Model" });
      if (check) {
        const current = await readFile(out, "utf8").catch(() => undefined);
        const upToDate = current === code;
        printResult(json, upToDate, { out, upToDate }, [upToDate ? `OK — ${out} matches the model` : `STALE — ${out} differs from the model; run typesys generate-sdk without --check`]);
      } else {
        await writeFile(out, code, "utf8");
        printResult(json, true, { out }, [`Wrote ${out}`]);
      }
    } catch (err) {
      printResult(json, false, { error: err instanceof Error ? err.message : String(err) }, [`FAIL — ${err instanceof Error ? err.message : String(err)}`]);
    }
    return;
  }

  if (command === "describe" || command === "discover" || command === "check-query") {
    if (!dir || (command !== "describe" && positionals.length === 0)) {
      usage();
      process.exitCode = 1;
      return;
    }
    try {
      const registry = await buildRegistryFromDir(dir, await loadBindings(bindingsPath));
      const model = await describeModel(registry, { prefixes: await domainPrefixes(registry) });
      if (command === "describe") {
        const text = `${JSON.stringify(model, null, 2)}\n`;
        if (out) {
          await writeFile(out, text, "utf8");
          printResult(json, true, { out }, [`Wrote ${out}`]);
        } else process.stdout.write(text);
      } else if (command === "discover") {
        const matches = discover(model, positionals.join(" "), limit === undefined ? {} : { limit });
        printResult(json, true, { matches }, matches.length === 0 ? ["No match."] : matches.map((m) => m.summary));
      } else {
        const diagnostics = validateQuery(model, JSON.parse(await readFile(positionals[0]!, "utf8")));
        const valid = !diagnostics.some((d) => d.severity === "error");
        printResult(json, valid, { valid, diagnostics }, [
          valid ? "OK — the query matches the model" : "INVALID",
          ...diagnostics.map((d) => `  ${d.severity} ${d.code} at ${d.path || "/"}: ${d.message}${d.suggestion ? ` (did you mean "${d.suggestion}"?)` : ""}`)
        ]);
      }
    } catch (err) {
      printResult(json, false, { error: err instanceof Error ? err.message : String(err) }, [`FAIL — ${err instanceof Error ? err.message : String(err)}`]);
    }
    return;
  }

  if (command === "diff") {
    const after = positionals[0];
    if (!dir || !after) {
      usage();
      process.exitCode = 1;
      return;
    }
    try {
      const read = async (file: string) => JSON.parse(await readFile(file, "utf8")) as ModelDescription;
      const { changes, underVersioned } = diffModels(await read(dir), await read(after));
      const ok = !changes.some((c) => c.impact === "breaking") && underVersioned.length === 0;
      printResult(json, ok, { changes, underVersioned }, [
        ...(changes.length === 0 ? ["No contract change."] : changes.map((c) => `${c.impact.padEnd(10)} ${c.subject}: ${c.change}`)),
        ...underVersioned.map((v) => `version    ${v.subject}: ${v.from} → ${v.to}, but its changes need a ${v.needs} bump`)
      ]);
    } catch (err) {
      printResult(json, false, { error: err instanceof Error ? err.message : String(err) }, [`FAIL — ${err instanceof Error ? err.message : String(err)}`]);
    }
    return;
  }

  usage();
  process.exitCode = command ? 1 : 0;
}

/** The domains a directory registers, as Type-name prefixes: everything but core's own Types, which are always pre-registered. */
async function domainPrefixes(registry: SemanticRegistry): Promise<string[]> {
  return [...new Set((await registry.listTypes()).filter((t) => !t.name.startsWith("core.")).map((t) => t.name.slice(0, t.name.indexOf(".") + 1)))];
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
