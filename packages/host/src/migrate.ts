import { createPool, pendingMigrations, runMigrations } from "@typesys/registry-store-postgres";
import { migrateWorkflowJournal } from "@typesys/workflow-postgres";
import { credentialResolver } from "./audit-cli.js";
import { readFile } from "node:fs/promises";
import { DeploymentError, parseDeployment, type Deployment } from "./deployment.js";
import { processEnvironment, type HostEnvironment } from "./host.js";

/** One store a deployment's `state` keeps in Postgres, and what migrating it did. */
export interface MigratedStore {
  /** `state.audit` or `state.workflows`. */
  readonly store: string;
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

/** Each Postgres store a deployment declares, with its connection string. */
function postgresStores(deployment: Deployment, env: HostEnvironment): { store: "state.audit" | "state.workflows"; url: string }[] {
  const resolve = credentialResolver(deployment, env);
  const out: { store: "state.audit" | "state.workflows"; url: string }[] = [];
  const s = deployment.state ?? {};
  if (s.audit?.kind === "postgres") out.push({ store: "state.audit", url: resolve(s.audit.url, "state.audit.url") });
  if (s.workflows?.kind === "postgres") out.push({ store: "state.workflows", url: resolve(s.workflows.url, "state.workflows.url") });
  return out;
}

/** Postgres's own message without the connection string, which can carry a password. */
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/postgres(?:ql)?:\/\/\S+/gi, "<connection string>");

/**
 * Migrates every store the deployment's `state` keeps in Postgres, over the
 * deployment's own connection strings (ADR-0117): the audit trail's tables
 * (ADR-0015, ADR-0105) and the workflow journal's (ADR-0066). Each runner is
 * idempotent and serialized by an advisory lock, so every replica's migrate
 * step, or two at once, is safe. Nothing else is created: a deployment's
 * sources are its own databases, never migrated by TypeSystem.
 */
export async function migrateDeployment(deployment: Deployment, env: HostEnvironment = processEnvironment): Promise<MigratedStore[]> {
  const out: MigratedStore[] = [];
  for (const { store, url } of postgresStores(deployment, env)) {
    const pool = createPool({ connectionString: url, max: 1 });
    try {
      if (store === "state.audit") {
        const r = await runMigrations(pool);
        out.push({ store, applied: r.applied, alreadyApplied: r.alreadyApplied.length });
      } else {
        await migrateWorkflowJournal(pool);
        out.push({ store, applied: [], alreadyApplied: 0 });
      }
    } catch (err) {
      throw new DeploymentError([`${store}: ${reason(err)}`]);
    } finally {
      await pool.end();
    }
  }
  return out;
}

/**
 * What a server would refuse to start over (ADR-0117): an audit database it
 * cannot reach, or one with migrations not yet applied. Reads the catalog and
 * the migration table only. The workflow journal is not checked: the server
 * migrates it itself as it starts (ADR-0066).
 */
export async function stateProblems(deployment: Deployment, env: HostEnvironment = processEnvironment): Promise<string[]> {
  const problems: string[] = [];
  for (const { store, url } of postgresStores(deployment, env)) {
    if (store !== "state.audit") continue;
    const pool = createPool({ connectionString: url, max: 1 });
    try {
      const pending = await pendingMigrations(pool);
      if (pending.length > 0) problems.push(`${store}: ${pending.length} migration${pending.length === 1 ? "" : "s"} not applied (${pending.join(", ")}): run \`typesys migrate <deployment.json>\``);
    } catch (err) {
      problems.push(`${store}: cannot read the database (${reason(err)})`);
    } finally {
      await pool.end();
    }
  }
  return problems;
}

const USAGE = `typesys migrate — create or update the tables a deployment keeps its state in (ADR-0117)

  typesys migrate <deployment.json> [--json]
      Migrate every store the deployment's state section keeps in Postgres (state.audit,
      state.workflows), over the connection strings its $secret references name. Safe to run
      again, and from several replicas at once. Never touches the deployment's sources.

The deployment file may also come from TYPESYS_DEPLOYMENT, as for the server.
`;

/** `typesys migrate ...`: the exit code. */
export async function migrateCommand(argv: readonly string[], env: HostEnvironment = processEnvironment): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const json = argv.includes("--json");
  const unknown = argv.filter((a) => a.startsWith("--") && a !== "--json");
  if (unknown.length > 0) {
    console.error(`Unknown option ${unknown[0]}\n\n${USAGE}`);
    return 2;
  }
  const positional = argv.filter((a) => !a.startsWith("--"));
  const file = positional[0] ?? env.env("TYPESYS_DEPLOYMENT");
  if (!file || positional.length > 1) {
    console.error(USAGE);
    return 2;
  }
  try {
    // Only the document: its packs are not needed to migrate where its state is kept.
    const deployment = parseDeployment(JSON.parse(await readFile(file, "utf8")) as unknown);
    const done = await migrateDeployment(deployment, env);
    if (json) console.log(JSON.stringify({ ok: true, deployment: deployment.name, stores: done }));
    else if (done.length === 0) console.log(`${deployment.name} keeps no state in Postgres: nothing to migrate.`);
    else
      for (const d of done)
        console.log(
          d.store === "state.workflows"
            ? `${d.store}: the workflow journal's tables are in place`
            : `${d.store}: applied ${d.applied.length ? d.applied.join(", ") : "nothing new"}${d.alreadyApplied ? ` (${d.alreadyApplied} already applied)` : ""}`
        );
    return 0;
  } catch (err) {
    const problems = err instanceof DeploymentError ? err.problems : [reason(err)];
    if (json) console.log(JSON.stringify({ ok: false, problems }));
    else console.error(`FAIL\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }
}
