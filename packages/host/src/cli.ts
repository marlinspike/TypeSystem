import { readFile, writeFile } from "node:fs/promises";
import { validateContract, type SemanticQuery } from "@typesys/core";
import { acceptanceFor, applyAcceptance, checkDeployment, renderDeployCheck, validateAcceptance, type DeployAcceptance, type DeployCheckReport } from "./check.js";
import { DeploymentError, type ConsumerSpec } from "./deployment.js";
import { buildHost } from "./host.js";
import { loadDeployment, loadExtensions } from "./load.js";
import { loadTests, renderTests, runTests, testsFileFor } from "./tests.js";

const USAGE = `typesys deploy — build and check deployments (ADR-0102, ADR-0104)

  typesys deploy build <deployment.json> [--packs-dir <dir>] [--offline] [--json]
      Build the deployment as the generic server would, check every declared database
      table and column against the database's catalog (no rows are read; --offline skips
      this), print its build id, and exit.
  typesys deploy check <current.json> <next.json> [--persona <name>]... [--object <Type>/<id>]...
                       [--queries <queries.json>] [--consumer <contract.json>]... [--packs-dir <dir>]
                       [--accept <acceptance.json>] [--write-acceptance <file> --by <name> --why <reason>] [--json]
      Build both, compare them, and exit 1 when the next one must not roll as is: a consumer
      whose contract it breaks, a breaking change to the model, a persona who may now read
      what they could not, or a policy that now admits someone it refused. A change that is
      meant passes with --accept: a file accepting each blocking line exactly, for these two
      builds, with who and why (ADR-0114). --write-acceptance writes one for every line
      blocking now, to review and commit; it still exits 1.

  typesys deploy test <deployment.json> [<tests.json>] [--packs-dir <dir>] [--json]
      Run the deployment's policy tests (ADR-0113): each reads, queries or previews an Action
      as one of its personas and says what must be returned, withheld or refused. The tests
      file defaults to <name>.tests.json beside the deployment. Exits 1 when one fails.

Credentials and addresses come from the environment, as each deployment's $secret and $env
references name them. Probes are reads, explained as each persona: nothing is written.
`;

interface Args {
  readonly positionals: string[];
  readonly personas: string[];
  readonly objects: { type: string; id: string }[];
  readonly consumers: string[];
  queries?: string;
  packsDir?: string;
  json: boolean;
  offline: boolean;
  help: boolean;
  accept?: string;
  writeAcceptance?: string;
  by?: string;
  why?: string;
}

function parse(argv: readonly string[]): Args {
  const out: Args = { positionals: [], personas: [], objects: [], consumers: [], json: false, offline: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--persona") out.personas.push(next());
    else if (a === "--object") {
      const v = next();
      const at = v.indexOf("/");
      if (at <= 0 || at === v.length - 1) throw new Error(`--object takes <Type>/<id>, got "${v}"`);
      out.objects.push({ type: v.slice(0, at), id: v.slice(at + 1) });
    } else if (a === "--consumer") out.consumers.push(next());
    else if (a === "--queries") out.queries = next();
    else if (a === "--packs-dir") out.packsDir = next();
    else if (a === "--json") out.json = true;
    else if (a === "--offline") out.offline = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--accept") out.accept = next();
    else if (a === "--write-acceptance") out.writeAcceptance = next();
    else if (a === "--by") out.by = next();
    else if (a === "--why") out.why = next();
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else out.positionals.push(a);
  }
  return out;
}

async function readConsumer(file: string): Promise<ConsumerSpec> {
  const doc = JSON.parse(await readFile(file, "utf8")) as { format?: unknown; name?: unknown; contract?: unknown };
  if (doc.format !== "typesys.consumer/1" || typeof doc.name !== "string") throw new Error(`${file}: not a typesys.consumer/1 contract (an application's contract.json)`);
  const problems = validateContract(doc.contract, `${file}: contract`);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return { name: doc.name, contract: doc.contract as Record<string, string> };
}

async function load(file: string, packsDir: string | undefined) {
  const { deployment, packs } = await loadDeployment(file, packsDir ? { packsDir } : {});
  return { deployment, packs, extensions: await loadExtensions(deployment) };
}

/** `typesys deploy ...`: the exit code. */
export async function deployCommand(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  let args: Args;
  try {
    args = parse(rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const fail = (err: unknown): number => {
    const problems = err instanceof DeploymentError ? err.problems : [err instanceof Error ? err.message : String(err)];
    if (args.json) console.log(JSON.stringify({ ok: false, problems }));
    else console.error(`FAIL\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  };
  if (sub === "build" && args.positionals.length === 1) {
    try {
      const { deployment, packs, extensions } = await load(args.positionals[0]!, args.packsDir);
      // Built as the server would, but writing nothing into the deployment's audit trail or journal.
      const host = await buildHost(deployment, { packs, extensions, state: "memory" });
      let sourceProblems: string[];
      try {
        sourceProblems = args.offline ? [] : await host.checkSources();
      } finally {
        await host.close();
      }
      if (sourceProblems.length > 0) throw new DeploymentError(sourceProblems);
      const result = { ok: true, deployment: deployment.name, build: host.build, packs: host.packs.map((p) => `${p.name}@${p.version}`) };
      console.log(args.json ? JSON.stringify(result) : `${result.deployment} builds: ${result.build}\npacks: ${result.packs.join(", ")}`);
      return 0;
    } catch (err) {
      return fail(err);
    }
  }
  if (sub === "check" && args.positionals.length === 2) {
    // Writing an acceptance is for a person to review before it is used: one run may not write one and pass with it (ADR-0114).
    if (args.writeAcceptance && args.accept) {
      console.error("--write-acceptance and --accept do not go together: write the acceptance, review it, then run the check again with --accept");
      return 2;
    }
    try {
      const [before, after] = await Promise.all(args.positionals.map((f) => load(f, args.packsDir)));
      const queries = args.queries ? (JSON.parse(await readFile(args.queries, "utf8")) as SemanticQuery[]) : [];
      if (!Array.isArray(queries)) throw new Error(`${args.queries}: must be a JSON list of queries`);
      let report: DeployCheckReport = await checkDeployment(before!, after!, {
        ...(args.personas.length ? { personas: args.personas } : {}),
        ...(args.objects.length ? { objects: args.objects } : {}),
        ...(queries.length ? { queries } : {}),
        consumers: await Promise.all(args.consumers.map(readConsumer))
      });
      if (args.writeAcceptance) {
        if (report.blocking.length === 0) {
          (report.ok ? process.stdout : process.stderr).write(renderDeployCheck(report));
          console.error(`Nothing blocks this upgrade, so there is nothing to accept: ${args.writeAcceptance} not written.`);
          return 0;
        }
        const acceptance = acceptanceFor(report, args.by ?? "", args.why ?? "");
        await writeFile(args.writeAcceptance, `${JSON.stringify(acceptance, null, 2)}\n`, "utf8");
        console.error(`Wrote ${args.writeAcceptance}: ${acceptance.accepted.length} blocking line${acceptance.accepted.length === 1 ? "" : "s"} accepted by ${acceptance.accepted[0]?.by ?? args.by}. Review it, then pass it with --accept.`);
      }
      if (args.accept) {
        const doc = JSON.parse(await readFile(args.accept, "utf8")) as unknown;
        const problems = validateAcceptance(doc);
        if (problems.length > 0) throw new DeploymentError(problems.map((p) => `${args.accept}: ${p}`));
        report = applyAcceptance(report, doc as DeployAcceptance);
      }
      if (args.json) console.log(JSON.stringify(report));
      else (report.ok ? process.stdout : process.stderr).write(renderDeployCheck(report));
      return report.ok ? 0 : 1;
    } catch (err) {
      return fail(err);
    }
  }
  if (sub === "test" && (args.positionals.length === 1 || args.positionals.length === 2)) {
    try {
      const file = args.positionals[0]!;
      const { deployment, packs, extensions } = await load(file, args.packsDir);
      const host = await buildHost(deployment, { packs, extensions, state: "memory" });
      try {
        const report = await runTests(host, await loadTests(args.positionals[1] ?? testsFileFor(file), host));
        if (args.json) console.log(JSON.stringify(report));
        else (report.ok ? process.stdout : process.stderr).write(renderTests(report));
        return report.ok ? 0 : 1;
      } finally {
        await host.close();
      }
    } catch (err) {
      return fail(err);
    }
  }
  console.error(USAGE);
  return sub === undefined || sub === "help" || sub === "--help" ? 0 : 2;
}
