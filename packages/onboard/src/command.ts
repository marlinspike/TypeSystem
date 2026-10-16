import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { createLlm, loadLlmConfig, type LanguageModel } from "@typesys/llm";
import type { PackArchive } from "@typesys/packs";
import { recordedModel, recordRefinement } from "./agent.js";
import { adaptersFor } from "./build.js";
import { baseline, type Proposal } from "./proposal.js";
import { refinementRequest, type Refinement } from "./refine.js";
import { decide, REVIEW_FORMAT, type Review } from "./review.js";
import { onboard } from "./run.js";
import { fromJsonSchema, fromOpenApi, fromPostgres, introspectPostgres, sourceModel, type CollectedSource } from "./sources.js";
import { checkRuntime, runChecks, type OnboardingCheck } from "./verify.js";

export const SOURCES_FORMAT = "typesys.onboarding-sources/1";

export const ONBOARD_USAGE = `typesys onboard — describe existing sources as a governed model (ADR-0076)

  typesys onboard collect --out <sources.json>
        [--postgres <ENV_VAR> --schema <name>... --source <id> --system <name>]
        [--openapi <file|url> --source <id>] [--json-schema <file>... --source <id> --key <Title>=<field>...]
      Reads metadata only: a PostgreSQL catalog (the connection string is
      read from ENV_VAR, never given on the command line), an OpenAPI
      document, JSON Schemas. Several sources: run once per source with the
      same --out; each run adds or replaces its source.

  typesys onboard request <sources.json> --domain <name> [--out <file>]
      The request a development model would be sent, for a coding agent to
      answer as the development model (agent mode). Its answer, a JSON
      object matching the request's schema, is given to propose --answer.

  typesys onboard propose <sources.json> --domain <name> --out <dir>
        [--answer <refinement.json> | --model <id> [--llm-config <file>]]
        [--review <review.json>] [--approved <approved.json>] [--previous <pack.json>] [--version <semver>]
      Baseline, refinement (an agent's answer, a configured model, or
      neither), what was approved before carried forward, the review
      applied, and the approved model verified. Writes proposal.json,
      pending.json, approved.json and, when it verifies, pack.json and
      adapters.json. Exits 1 if verification fails.

  typesys onboard review <dir> --review <review.json> --by <name>
        [--accept <id>...] [--reject <id>=<why>...] [--rename <id>=<Name>[/<inverse>]...] [--accept-rest]
      Records an expert's decisions on <dir>/proposal.json in review.json.
      Run propose again to apply them.

  typesys onboard check <dir>
      Reads the approved model from its live sources and runs the generated
      checks. Credentials come from the variables adapters.json names.

--json prints one JSON object instead of text.`;

interface Args {
  readonly positionals: string[];
  readonly flags: Map<string, string[]>;
}

function parse(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const name = a.slice(2);
    const boolean = name === "json" || name === "accept-rest";
    const value = boolean ? "true" : argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positionals, flags };
}

const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8")) as T;
const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
const pairs = (values: readonly string[] | undefined, flag: string): Record<string, string> =>
  Object.fromEntries(
    (values ?? []).map((v) => {
      const at = v.indexOf("=");
      if (at <= 0) throw new Error(`--${flag} takes <id>=<value>, got "${v}"`);
      return [v.slice(0, at), v.slice(at + 1)];
    })
  );

interface SourcesFile {
  readonly format: typeof SOURCES_FORMAT;
  readonly sources: readonly CollectedSource[];
}

async function readSources(file: string): Promise<CollectedSource[]> {
  const doc = await json<SourcesFile>(file);
  if (doc.format !== SOURCES_FORMAT) throw new Error(`${file} is not ${String(SOURCES_FORMAT)}: write it with typesys onboard collect`);
  return [...doc.sources];
}

/** `typesys onboard`: returns the exit code. */
export async function onboardCommand(argv: readonly string[], out: (s: string) => void = console.log, env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const [sub, ...rest] = argv;
  let args: Args;
  try {
    args = parse(rest);
  } catch (err) {
    out((err as Error).message);
    return 1;
  }
  const one = (name: string) => args.flags.get(name)?.at(-1);
  const all = (name: string) => args.flags.get(name) ?? [];
  const asJson = args.flags.has("json");
  const print = (ok: boolean, payload: Record<string, unknown>, lines: string[]) => {
    out(asJson ? JSON.stringify({ ok, ...payload }) : lines.join("\n"));
    return ok ? 0 : 1;
  };

  try {
    switch (sub) {
      case "collect": {
        const target = one("out");
        if (!target) break;
        const source = one("source");
        let collected: CollectedSource;
        if (one("postgres")) {
          const variable = one("postgres")!;
          const connectionString = env[variable];
          if (!connectionString) throw new Error(`${variable} is not set`);
          const pool = new pg.Pool({ connectionString });
          try {
            const schemas = all("schema");
            if (!schemas.length) throw new Error("--postgres needs at least one --schema");
            // The driver's message can quote the connection string: report the variable and the error's code only.
            const catalog = await introspectPostgres(pool, schemas).catch((err: unknown) => {
              throw new Error(`Could not read the database ${variable} names: ${(err as { code?: string }).code ?? "the connection failed"}`);
            });
            collected = fromPostgres(catalog, { source: source ?? "db", ...(one("system") ? { system: one("system")! } : {}) });
          } finally {
            await pool.end();
          }
        } else if (one("openapi")) {
          const where = one("openapi")!;
          const doc = /^https?:\/\//.test(where) ? ((await (await fetch(where)).json()) satisfies unknown) : await json<unknown>(where);
          collected = fromOpenApi(doc, { source: source ?? "api", ...(one("system") ? { system: one("system")! } : {}) });
        } else if (all("json-schema").length) {
          collected = fromJsonSchema(await Promise.all(all("json-schema").map((f) => json<unknown>(f))), { source: source ?? "schemas", ...(one("system") ? { system: one("system")! } : {}), keys: pairs(all("key"), "key") });
        } else break;
        let existing: CollectedSource[] = [];
        try {
          existing = await readSources(target);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        const sources = [...existing.filter((s) => s.info.id !== collected.info.id), collected];
        sourceModel(sources); // ids must be unique across sources
        await write(target, { format: SOURCES_FORMAT, sources });
        return print(true, { source: collected.info, evidence: collected.evidence.length }, [`Collected ${collected.info.id} (${collected.info.kind}): ${collected.entities.length} entities, ${collected.operations.length} operations, ${collected.evidence.length} facts → ${target}`]);
      }

      case "request": {
        const [file] = args.positionals;
        const domain = one("domain");
        if (!file || !domain) break;
        const model = sourceModel(await readSources(file));
        const req = refinementRequest(model, baseline(model, domain));
        const text = `SYSTEM:\n${req.system}\n\n${req.prompt}\n\nANSWER: one JSON object matching this schema:\n${JSON.stringify(req.schema, null, 2)}\n`;
        if (one("out")) await writeFile(one("out")!, text, "utf8");
        else if (!asJson) out(text);
        return asJson ? print(true, { system: req.system, prompt: req.prompt, schema: req.schema }, []) : one("out") ? print(true, {}, [`Wrote the request to ${one("out")}`]) : 0;
      }

      case "propose": {
        const [file] = args.positionals;
        const domain = one("domain");
        const dir = one("out");
        if (!file || !domain || !dir) break;
        const sources = await readSources(file);
        const model = sourceModel(sources);
        let lm: LanguageModel | undefined;
        if (one("answer")) {
          // Agent mode: the answer is recorded against the request it answers, then replayed through the model layer like any model's.
          const { recording } = await recordRefinement(model, baseline(model, domain), await json<Refinement>(one("answer")!), "a coding agent acting as the development model (agent mode)");
          await mkdir(dir, { recursive: true });
          await write(path.join(dir, "recording.json"), [recording]);
          lm = recordedModel([recording]);
        } else if (one("model")) {
          const config = await loadLlmConfig(one("llm-config"));
          if (!config) throw new Error("--model needs a model configuration: --llm-config, TYPESYS_LLM_CONFIG or typesys.llm.json");
          lm = createLlm(config).model(one("model")!, "development");
        }
        const review = one("review") ? await readReview(one("review")!, domain) : undefined;
        const final = await onboard({
          domain,
          sources,
          ...(lm ? { model: lm } : {}),
          ...(review ? { review } : {}),
          ...(one("approved") ? { approved: await json<Proposal>(one("approved")!) } : {}),
          ...(one("previous") ? { previous: await json<PackArchive>(one("previous")!) } : {}),
          ...(one("version") ? { version: one("version")! } : {})
        });
        await mkdir(dir, { recursive: true });
        await write(path.join(dir, "proposal.json"), final.proposal);
        await write(path.join(dir, "pending.json"), final.review.pending);
        await write(path.join(dir, "approved.json"), final.review.approved);
        if (final.verification.pack) await write(path.join(dir, "pack.json"), final.verification.pack);
        await write(path.join(dir, "adapters.json"), final.verification.built.adapters);
        await write(path.join(dir, "checks.json"), final.verification.checks);
        const v = final.verification;
        const m = final.metrics;
        return print(v.ok, { metrics: m, diagnostics: v.diagnostics, pending: final.review.pending, rejected: final.proposal.rejected, policies: v.built.policies }, [
          `${v.ok ? "OK" : "FAILED"} — ${domain}: ${m.approved.types} Types approved, ${m.pending} items pending review, ${m.rejected} model items refused`,
          ...final.proposal.rejected.map((r) => `  refused ${r.kind}: ${r.reason}`),
          ...final.review.pending.map((p) => `  pending ${p.id} (${p.reason}): ${p.summary}`),
          ...v.diagnostics.map((d) => `  ${d.severity} ${d.code}: ${d.message}`),
          ...(v.built.policies.length ? [`  policy rules to write: ${v.built.policies.join(", ")}`] : []),
          `  → ${dir}`
        ]);
      }

      case "review": {
        const [dir] = args.positionals;
        const file = one("review");
        const by = one("by");
        if (!dir || !file || !by) break;
        const proposal = await json<Proposal>(path.join(dir, "proposal.json"));
        let previous: Review | undefined;
        try {
          previous = await readReview(file, proposal.domain);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        const next = decide(proposal, previous, { by, accept: all("accept"), reject: pairs(all("reject"), "reject"), rename: pairs(all("rename"), "rename"), acceptRest: args.flags.has("accept-rest") });
        await write(file, next);
        return print(true, { decisions: Object.keys(next.decisions).length }, [`${Object.keys(next.decisions).length} decisions in ${file}; run propose with --review ${file} to apply them`]);
      }

      case "check": {
        const [dir] = args.positionals;
        if (!dir) break;
        const pack = await json<PackArchive>(path.join(dir, "pack.json"));
        const pools = new Map<string, pg.Pool>();
        try {
          const adapters = adaptersFor(await json(path.join(dir, "adapters.json")), {
            secret: (n) => env[n],
            pool: (id, connectionString) => pools.get(id) ?? pools.set(id, new pg.Pool({ connectionString })).get(id)!
          });
          const checks = await json<OnboardingCheck[]>(path.join(dir, "checks.json"));
          const results = await runChecks(await checkRuntime(pack, adapters), checks);
          const ok = results.every((r) => r.outcome !== "failed");
          return print(ok, { results }, results.map((r) => `${r.outcome.padEnd(12)} ${r.id}: ${r.detail}`));
        } finally {
          await Promise.all([...pools.values()].map((p) => p.end()));
        }
      }
    }
  } catch (err) {
    return print(false, { error: (err as Error).message }, [`FAIL — ${(err as Error).message}`]);
  }
  out(ONBOARD_USAGE);
  return 1;
}

async function readReview(file: string, domain: string): Promise<Review> {
  const r = await json<Review>(file);
  if (r.format !== REVIEW_FORMAT || r.domain !== domain) throw new Error(`${file} is not a ${REVIEW_FORMAT} review of ${domain}`);
  return r;
}
