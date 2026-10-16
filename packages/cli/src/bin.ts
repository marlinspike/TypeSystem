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
import { checkUpgrade, signPack, verifyPack, type PackArchive, type PackDiagnostic } from "@typesys/packs";

function usage(): void {
  console.log(`typesys — TypeSys declarative authoring CLI

Usage:
  typesys init <dir> [--name <domainName>] [--force] [--json]
  typesys validate <dir> [--bindings <module.js>] [--json]
  typesys generate-types <dir> [--bindings <module.js>] [--out <file.ts>]
  typesys generate-sdk <dir> [--bindings <module.js>] --out <file.ts> [--name <Model>] [--check] [--json]
  typesys describe <dir> [--bindings <module.js>] [--out <model.json>]
  typesys diff <before.json> <after.json> [--json]
  typesys discover <dir> <task words...> [--bindings <module.js>] [--limit <n>] [--json]
  typesys check-query <dir> <query.json> [--bindings <module.js>] [--json]
  typesys pack inspect <pack.json> [--json]
  typesys pack verify <pack.json> [--trust <keyId>=<public.pem>]... [--revoke <keyId|sha256:digest>]... [--json]
  typesys pack sign <pack.json> --key-id <id> --private-key <private.pem> --out <signed.json>
  typesys pack check-upgrade <next.json> --installed <pack.json>... [--json]
  typesys engineer plan|scaffold|verify ...   (with @typesys/engineer installed)
  typesys onboard collect|request|propose|review|check ...   (with @typesys/onboard installed)

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

  pack          Domain packs (ADR-0059), all offline. inspect prints what a
                pack contains and what a deployment must supply (bindings,
                policy rules, data sources, other packs). verify checks the
                digest and, with --trust, an Ed25519 signature by one of the
                given keys; --revoke refuses a pack any revoked key signed,
                or a withdrawn build by digest (ADR-0069). sign adds one. check-upgrade compares a new
                version with the installed packs: the contract diff, the
                version bump it needs, and every dependent's range. verify
                and check-upgrade exit 1 on any finding.

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
  trust: string[];
  revoke: string[];
  installed: string[];
  keyId?: string;
  privateKey?: string;
  /** Arguments after `<dir>` that are not flags. */
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, dir, ...rest] = argv;
  const result: ParsedArgs = { command, dir, json: false, force: false, check: false, trust: [], revoke: [], installed: [], positionals: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--bindings") result.bindings = rest[++i];
    else if (rest[i] === "--out") result.out = rest[++i];
    else if (rest[i] === "--name") result.name = rest[++i];
    else if (rest[i] === "--json") result.json = true;
    else if (rest[i] === "--force") result.force = true;
    else if (rest[i] === "--check") result.check = true;
    else if (rest[i] === "--limit") result.limit = Number(rest[++i]);
    else if (rest[i] === "--trust") result.trust.push(rest[++i]!);
    else if (rest[i] === "--revoke") result.revoke.push(rest[++i]!);
    else if (rest[i] === "--installed") result.installed.push(rest[++i]!);
    else if (rest[i] === "--key-id") result.keyId = rest[++i];
    else if (rest[i] === "--private-key") result.privateKey = rest[++i];
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

/**
 * A command that lives in its own package, so the CLI stays small: `typesys
 * engineer` (ADR-0071) and `typesys onboard` (ADR-0076) run when theirs is
 * installed.
 */
async function delegate(command: string, specifier: string, entry: string, argv: string[]): Promise<void> {
  let mod: Record<string, (argv: readonly string[]) => Promise<number>>;
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch (err) {
    // Only a missing package means "install it"; anything else is the package failing to load, and its error says why.
    const e = err as { code?: string; message?: string };
    const missing = (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND") && (e.message ?? "").includes(`'${specifier}'`);
    console.error(missing ? `typesys ${command} needs ${specifier}: npm install --save-dev ${specifier}` : `typesys ${command}: ${specifier} failed to load: ${e.message ?? String(err)}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await mod[entry]!(argv);
}

async function main(): Promise<void> {
  if (process.argv[2] === "engineer") return delegate("engineer", "@typesys/engineer", "engineerCommand", process.argv.slice(3));
  if (process.argv[2] === "onboard") return delegate("onboard", "@typesys/onboard", "onboardCommand", process.argv.slice(3));
  const args = parseArgs(process.argv.slice(2));
  const { command, dir, bindings: bindingsPath, out, name, json, force, check, limit, positionals } = args;

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

  if (command === "pack") {
    await packCommand(dir, args);
    return;
  }

  usage();
  process.exitCode = command ? 1 : 0;
}

const readPack = async (file: string) => JSON.parse(await readFile(file, "utf8")) as PackArchive;
const diagnosticLine = (d: PackDiagnostic) => `${d.code.padEnd(22)} ${d.pack}${d.subject ? ` (${d.subject})` : ""}: ${d.message}`;

async function packCommand(sub: string | undefined, args: ParsedArgs): Promise<void> {
  const [file] = args.positionals;
  if (!file || !["inspect", "verify", "sign", "check-upgrade"].includes(sub ?? "")) {
    usage();
    process.exitCode = 1;
    return;
  }
  try {
    const pack = await readPack(file);
    if (sub === "inspect") {
      const { name, version, description, digest, requires, requirements, contents, signatures } = pack;
      const counts = { types: contents.types.length, actions: contents.actions.length, dataSources: contents.dataSources.length, mappings: contents.mappings.length };
      printResult(args.json, true, { name, version, description, digest, requires, requirements, counts, signedBy: (signatures ?? []).map((s) => s.keyId) }, [
        `${name} ${version}  ${digest}`,
        description,
        `requires:      ${Object.entries(requires).map(([n, r]) => `${n} ${r}`).join(", ") || "nothing"}`,
        `contains:      ${counts.types} Types, ${counts.actions} Actions, ${counts.dataSources} data sources, ${counts.mappings} mappings`,
        `needs code:    ${[...requirements.computed, ...requirements.preconditions].join(", ") || "none"}`,
        `needs rules:   ${requirements.policies.join(", ") || "none"}`,
        `needs sources: ${requirements.dataSources.join(", ") || "none"}`,
        `signed by:     ${(signatures ?? []).map((s) => s.keyId).join(", ") || "nobody"}`
      ]);
    } else if (sub === "verify") {
      const trustedKeys: Record<string, string> = {};
      for (const t of args.trust) {
        const at = t.indexOf("=");
        if (at <= 0) throw new Error(`--trust takes <keyId>=<public.pem>, got "${t}"`);
        trustedKeys[t.slice(0, at)] = await readFile(t.slice(at + 1), "utf8");
      }
      // A digest, however it is spelled, is a digest: a value that looks like one but is malformed is refused, never taken as a key id.
      const digestOf = (r: string): string | undefined => {
        const hex = /^sha256:/i.test(r) ? r.slice("sha256:".length) : /^[0-9a-f]{64}$/i.test(r) ? r : undefined;
        if (hex === undefined) return undefined;
        if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`--revoke ${r} is not a sha256 digest`);
        return `sha256:${hex.toLowerCase()}`;
      };
      const revokedKeys = Object.fromEntries(args.revoke.filter((r) => digestOf(r) === undefined).map((r) => [r, {}]));
      const revokedDigests = Object.fromEntries(args.revoke.flatMap((r) => (digestOf(r) ? [[digestOf(r)!, {}]] : [])));
      const found = verifyPack(pack, { ...(args.trust.length > 0 ? { trustedKeys } : {}), revokedKeys, revokedDigests });
      printResult(args.json, found.length === 0, { name: pack.name, version: pack.version, digest: pack.digest, diagnostics: found }, found.length === 0 ? [`OK — ${pack.name} ${pack.version} is intact${args.trust.length > 0 ? " and signed by a trusted key" : ""}`] : found.map(diagnosticLine));
    } else if (sub === "sign") {
      if (!args.keyId || !args.privateKey || !args.out) throw new Error("sign needs --key-id, --private-key and --out");
      const found = verifyPack(pack);
      if (found.length > 0) throw new Error(`refusing to sign a pack that does not verify: ${found.map((d) => d.message).join("; ")}`);
      await writeFile(args.out, `${JSON.stringify(signPack(pack, args.keyId, await readFile(args.privateKey, "utf8")), null, 2)}\n`, "utf8");
      printResult(args.json, true, { out: args.out, keyId: args.keyId }, [`Signed ${pack.name} ${pack.version} as ${args.keyId}: ${args.out}`]);
    } else {
      const report = await checkUpgrade(await Promise.all(args.installed.map(readPack)), pack);
      const ok = report.diagnostics.length === 0;
      printResult(args.json, ok, { ...report }, [
        `${report.pack} ${report.from} → ${report.to}: needs a ${report.needs} bump, is a ${report.made} bump`,
        ...report.changes.map((c) => `${c.impact.padEnd(10)} ${c.subject}: ${c.change}`),
        ...report.diagnostics.map(diagnosticLine)
      ]);
    }
  } catch (err) {
    printResult(args.json, false, { error: err instanceof Error ? err.message : String(err) }, [`FAIL — ${err instanceof Error ? err.message : String(err)}`]);
  }
}

/** The domains a directory registers, as Type-name prefixes: everything but core's own Types, which are always pre-registered. */
async function domainPrefixes(registry: SemanticRegistry): Promise<string[]> {
  return [...new Set((await registry.listTypes()).filter((t) => !t.name.startsWith("core.")).map((t) => t.name.slice(0, t.name.indexOf(".") + 1)))];
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
