import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { draftDeployment, DRAFT_ROLES, type DraftResult } from "./deployment.js";
import { decide } from "./review.js";
import { onboard } from "./run.js";
import { fromPostgres, introspectPostgres } from "./sources.js";
import { SOURCES_FORMAT } from "./command.js";

export const INIT_USAGE = `typesys init <dir> --from postgres <ENV_VAR> --schema <name>... [--domain <name>]
             [--source <id>] [--system <name>] [--by <name>] [--force] [--json]

  Onboards a PostgreSQL database and writes everything the generic server needs
  to serve it, governed, on this machine (ADR-0111): the model as a pack, a
  deployment document whose sources map every table onboarding found, a draft
  rule for every policy the model names, personas with tokens, policy tests,
  and the onboarding record (what was collected, proposed and accepted).

  The connection string is read from ENV_VAR and never written anywhere; the
  deployment refers to it by name. Only catalog metadata is read, and whether
  each table has rows; never a row's values.
  Everything the catalog declares is accepted as collected and recorded as
  decided by --by (default "typesys init"); review onboarding/review.json and
  run typesys onboard again to change any of it.

  Then: npx typesys dev <dir>/<domain>.deployment.json

  Without --from, typesys init <dir> [--name <domain>] scaffolds YAML Types instead
  (typesys --help lists every command).`;

interface InitArgs {
  dir?: string;
  from?: string;
  variable?: string;
  schemas: string[];
  domain?: string;
  source?: string;
  system?: string;
  by?: string;
  force: boolean;
  json: boolean;
}

function parse(argv: readonly string[]): InitArgs {
  const out: InitArgs = { schemas: [], force: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--from") {
      out.from = next();
      if (out.from === "postgres") out.variable = next();
    } else if (a === "--schema") out.schemas.push(next());
    else if (a === "--domain") out.domain = next();
    else if (a === "--source") out.source = next();
    else if (a === "--system") out.system = next();
    else if (a === "--by") out.by = next();
    else if (a === "--force") out.force = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") throw new HelpRequested();
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else if (out.dir === undefined) out.dir = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  return out;
}

class HelpRequested extends Error {}

const exists = (file: string) => access(file).then(() => true, () => false);
const write = (file: string, value: unknown) => writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");

/** A domain name the model accepts, from a directory's name: `my-shop` → `myshop`. */
const domainFrom = (dir: string): string => path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9]/g, "") || "app";

/**
 * The policy tests a drafted deployment starts with (ADR-0113): what its
 * draft rules promise, as queries over each Type, so no object id or value
 * from the database is written into them. A `returns` test is drafted only
 * for a Type whose table has rows.
 */
function draftTests(types: readonly string[], hasRows: Readonly<Record<string, boolean>>, sensitiveOf: Readonly<Record<string, readonly string[]>>): unknown {
  const tests: unknown[] = [];
  for (const type of types) {
    const hidden = sensitiveOf[type] ?? [];
    tests.push({ name: `a reader lists ${type}${hidden.length ? ` without ${hidden.join(", ")}` : ""}`, as: "reader", query: type, ...(hidden.length ? { withholds: hidden } : {}) });
    if (hidden.length && hasRows[type]) tests.push({ name: `a steward sees ${hidden.join(", ")} on ${type}`, as: "steward", query: type, returns: hidden });
    tests.push({ name: `anyone else is refused ${type}`, as: "anonymous", query: type, refused: true });
  }
  return { format: "typesys.deployment-tests/1", tests };
}

function readme(domain: string, file: string, draft: DraftResult, variable: string): string {
  const t = draft.tokens;
  return `# ${domain}

Drafted by \`typesys init\` from the database \`${variable}\` names (ADR-0111).

| File | What it is |
|---|---|
| \`${file}\` | The deployment: the model (a pack), the database's tables as sources, the policy rules, and the personas with their tokens |
| \`${domain}.tests.json\` | What the rules must keep true, checked by \`npx typesys deploy test ${file}\` |
| \`packs/\` | The model as a pack archive, content-addressed |
| \`onboarding/\` | What was collected from the catalog, what was proposed, and what was accepted (\`review.json\`) |

## Serve it

\`\`\`bash
export ${variable}=postgres://...        # the same connection string init read
npx typesys dev ${file}
\`\`\`

## Who sees what

Every rule starts as one role per kind of rule. Nothing is open to everyone.

| Persona | Roles | Token | Sees |
|---|---|---|---|
| reader | ${DRAFT_ROLES.read} | \`${t.reader}\` | every Type, without the parts onboarding marked sensitive |
| steward | ${DRAFT_ROLES.read}, ${DRAFT_ROLES.sensitive} | \`${t.steward}\` | everything |
${t.operator ? `| operator | ${DRAFT_ROLES.read}, ${DRAFT_ROLES.invoke} | \`${t.operator}\` | every Type, and may invoke Actions |\n` : ""}| anyone else | none | none | nothing: refused |

Change a rule in \`policies\`, then run \`npx typesys deploy check\` with the old and new
files to see who would newly read what, and \`npx typesys deploy test\` to keep the tests true.

## Before anyone else uses it

This is a demo deployment (\`"demo": true\`): its tokens are fixed, so anyone who has one
holds its roles, and its audit trail is kept in memory. For a shared deployment, remove
\`demo\`, replace \`identity\` with your identity provider
(\`{ "kind": "oidc", "issuer": { "$env": "OIDC_ISSUER" } }\`), and keep the audit trail in
Postgres with signed checkpoints (\`state.audit\`, see docs/how-to/deploy-with-containers.md).
\`npx typesys deploy build\` names everything still missing.
`;
}

/** `typesys init <dir> --from postgres ...`: the exit code. */
export async function initCommand(argv: readonly string[], out: (s: string) => void = console.log, env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  let args: InitArgs;
  try {
    args = parse(argv);
  } catch (err) {
    out(err instanceof HelpRequested ? INIT_USAGE : `${(err as Error).message}\n\n${INIT_USAGE}`);
    return err instanceof HelpRequested ? 0 : 2;
  }
  const fail = (message: string, extra: Record<string, unknown> = {}) => {
    out(args.json ? JSON.stringify({ ok: false, error: message, ...extra }) : `FAIL — ${message}`);
    return 1;
  };
  if (!args.dir || args.from !== "postgres" || !args.variable) {
    out(INIT_USAGE);
    return 2;
  }
  if (args.schemas.length === 0) return fail("--from postgres needs at least one --schema (public, for most databases)");
  const variable = args.variable;
  const connectionString = env[variable];
  if (!connectionString) return fail(`${variable} is not set: export it with the database's connection string, then run init again`);
  const domain = args.domain ?? domainFrom(args.dir);
  if (!/^[a-z][a-z0-9]*$/.test(domain)) return fail(`--domain must be lowercase letters and digits, starting with a letter: "${domain}" is not (Types are named ${"<domain>.<Name>"})`);
  const source = args.source ?? `${domain}-db`;
  const dir = path.resolve(args.dir);
  const file = `${domain}.deployment.json`;
  if (!args.force && (await exists(path.join(dir, file)))) return fail(`${path.join(args.dir, file)} exists: change it with typesys onboard propose --deployment, or pass --force to draft it again`);

  const pool = new pg.Pool({ connectionString, max: 2 });
  let collected;
  try {
    // The driver's message can quote the connection string: report the variable and the error's code only.
    const catalog = await introspectPostgres(pool, args.schemas).catch((err: unknown) => {
      throw new Error(`could not read the database ${variable} names: ${(err as { code?: string }).code ?? "the connection failed"}`);
    });
    collected = fromPostgres(catalog, { source, ...(args.system ? { system: args.system } : {}) });
    if (collected.entities.length === 0) return fail(`no tables or views in schema ${args.schemas.join(", ")} of the database ${variable} names`);
    const by = args.by ?? "typesys init";
    const first = await onboard({ domain, sources: [collected] });
    const review = decide(first.proposal, undefined, { by, acceptRest: true });
    const final = await onboard({ domain, sources: [collected], review });
    const v = final.verification;
    if (!v.ok || !v.pack) {
      return fail(`the model onboarding proposed does not verify: ${v.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")}`, { diagnostics: v.diagnostics });
    }
    const pack = v.pack;
    const packFile = `packs/${pack.name}-${pack.version}.typesys-pack.json`;
    const draft = draftDeployment(pack, v.built.adapters, { name: domain, packFile, connectionEnv: { [source]: variable } });

    // Whether each table has rows, for the drafted tests: EXISTS only, so no id or value is read.
    const hasRows: Record<string, boolean> = {};
    for (const plan of v.built.adapters) {
      if (plan.kind !== "postgres-table") continue;
      for (const [type, m] of Object.entries(plan.types)) {
        const q = (n: string) => n.split(".").map((p) => `"${p.replace(/"/g, '""')}"`).join(".");
        hasRows[type] = await pool.query<{ any: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${q(m.table)}) AS any`).then((r) => r.rows[0]?.any === true, () => false);
      }
    }
    const sensitiveOf: Record<string, string[]> = {};
    for (const t of pack.contents.types) {
      const pp = (t.schema as { "x-policy"?: { propertyPolicies?: Record<string, string> } })["x-policy"]?.propertyPolicies ?? {};
      sensitiveOf[t.name] = Object.keys(pp).sort();
    }

    await mkdir(path.join(dir, "packs"), { recursive: true });
    await mkdir(path.join(dir, "onboarding"), { recursive: true });
    await write(path.join(dir, packFile), pack);
    await write(path.join(dir, file), draft.deployment);
    await write(path.join(dir, `${domain}.tests.json`), draftTests(pack.contents.types.map((t) => t.name), hasRows, sensitiveOf));
    await write(path.join(dir, "README.md"), readme(domain, file, draft, variable));
    await write(path.join(dir, "onboarding", "sources.json"), { format: SOURCES_FORMAT, sources: [collected] });
    await write(path.join(dir, "onboarding", "proposal.json"), final.proposal);
    await write(path.join(dir, "onboarding", "review.json"), review);
    await write(path.join(dir, "onboarding", "approved.json"), final.review.approved);
    await write(path.join(dir, "onboarding", "pack.json"), pack);
    await write(path.join(dir, "onboarding", "adapters.json"), v.built.adapters);

    const m = final.metrics.approved;
    const rel = (f: string) => path.join(args.dir!, f);
    const payload = { dir, deployment: path.join(dir, file), pack: { name: pack.name, version: pack.version, digest: pack.digest }, types: pack.contents.types.map((t) => t.name), policies: draft.rules, tokens: draft.tokens };
    if (args.json) {
      out(JSON.stringify({ ok: true, ...payload }));
      return 0;
    }
    out(
      [
        `Onboarded ${collected.info.system} into "${domain}": ${m.types} Types, ${m.properties} properties, ${m.relationships} relationship${m.relationships === 1 ? "" : "s"}, ${m.sensitive} sensitive fields`,
        ...pack.contents.types.map((t) => `  ${t.name}${sensitiveOf[t.name]!.length ? `  (sensitive: ${sensitiveOf[t.name]!.join(", ")})` : ""}`),
        "",
        `Wrote ${rel(file)}, ${rel(`${domain}.tests.json`)}, ${rel(packFile)}, ${rel("README.md")} and ${rel("onboarding/")}`,
        `Policies (each one role, nothing open to everyone): ${[...draft.rules.read, ...draft.rules.sensitive, ...draft.rules.invoke].join(", ")}`,
        "",
        "Tokens for this machine:",
        ...Object.entries(draft.tokens).map(([p, t]) => `  ${p.padEnd(8)} ${t}`),
        "",
        "Next:",
        `  npx typesys dev ${rel(file)}`
      ].join("\n")
    );
    return 0;
  } catch (err) {
    return fail((err as Error).message);
  } finally {
    await pool.end();
  }
}
