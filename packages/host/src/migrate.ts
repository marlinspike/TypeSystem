import { createPool, pendingMigrations, runMigrations } from "@typesys/registry-store-postgres";
import { migrateWorkflowJournal } from "@typesys/workflow-postgres";
import { credentialResolver } from "./audit-cli.js";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { DeploymentError, parseDeployment, type Credential, type Deployment } from "./deployment.js";
import { processEnvironment, type HostEnvironment } from "./host.js";

/** One store a deployment's `state` keeps in Postgres, and what migrating it did. */
export interface MigratedStore {
  /** `state.audit` or `state.workflows`. */
  readonly store: string;
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
  /** The server's role, granted read and append only, when the deployment names an owner (ADR-0124). */
  readonly runtimeRole?: string;
}

interface PostgresStore {
  readonly store: "state.audit" | "state.workflows";
  /** The server's connection. */
  readonly url: string;
  /** The owner's, when the deployment separates them (ADR-0124). */
  readonly ownerUrl?: string;
}

/** Each Postgres store a deployment declares, with its connection strings. */
function postgresStores(deployment: Deployment, env: HostEnvironment, withOwner = false): PostgresStore[] {
  const resolve = credentialResolver(deployment, env);
  const out: PostgresStore[] = [];
  const s = deployment.state ?? {};
  const owner = (c: Credential | undefined, at: string) => (withOwner && c !== undefined ? { ownerUrl: resolve(c, at) } : {});
  if (s.audit?.kind === "postgres") out.push({ store: "state.audit", url: resolve(s.audit.url, "state.audit.url"), ...owner(s.audit.ownerUrl, "state.audit.ownerUrl") });
  if (s.workflows?.kind === "postgres") out.push({ store: "state.workflows", url: resolve(s.workflows.url, "state.workflows.url"), ...owner(s.workflows.ownerUrl, "state.workflows.ownerUrl") });
  return out;
}

/** The role a connection string signs in as. */
export function roleOf(url: string): string {
  let user: string;
  try {
    user = decodeURIComponent(new URL(url).username);
  } catch (err) {
    throw new Error("a state connection string is not a URL", { cause: err });
  }
  if (!user) throw new Error("a state connection string names no user: name the role it signs in as");
  return user;
}

/** What the server's role may do on each store's tables: read and append; the journal also moves a run's index row forward. */
const GRANTS: Readonly<Record<PostgresStore["store"], readonly string[]>> = {
  "state.audit": ["GRANT SELECT, INSERT ON audit_events, audit_checkpoints TO %R", "GRANT SELECT ON registry_postgres_schema_migrations TO %R"],
  "state.workflows": ["GRANT SELECT, INSERT ON typesys_workflow_events TO %R", "GRANT SELECT, INSERT, UPDATE ON typesys_workflow_runs TO %R"]
};

/**
 * Grants the server's role what it needs on a store migrated by its owner, and
 * nothing else (ADR-0124): no DELETE, no TRUNCATE, and, not owning the tables,
 * no way to disable their triggers. Creates the role, with the password its
 * connection string carries, when it does not exist and the owner may.
 */
async function grantRuntime(owner: Pool, store: PostgresStore): Promise<string> {
  const role = roleOf(store.url);
  if (role === roleOf(store.ownerUrl!)) throw new Error(`${store.store}.url and ${store.store}.ownerUrl sign in as the same role, ${role}: give the server a role of its own`);
  const client = await owner.connect();
  try {
    const ident = client.escapeIdentifier(role);
    const exists = await client.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1", [role]);
    if (exists.rowCount === 0) {
      const password = decodeURIComponent(new URL(store.url).password);
      try {
        await client.query(`CREATE ROLE ${ident} LOGIN${password ? ` PASSWORD ${client.escapeLiteral(password)}` : ""}`);
      } catch (err) {
        throw new Error(`the server's role ${role} does not exist, and the owner cannot create it (${(err as Error).message}): create it as a login role, then run migrate again`, { cause: err });
      }
    } else if ((exists.rows[0] as { rolsuper: boolean }).rolsuper) throw new Error(`the server's role ${role} is a superuser, which no grant can limit: give the server an ordinary role`);
    const owns = await client.query<{ owns: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = ANY($2) AND pg_has_role($1, tableowner, 'USAGE')) AS owns",
      [role, store.store === "state.audit" ? ["audit_events", "audit_checkpoints"] : ["typesys_workflow_events", "typesys_workflow_runs"]]
    );
    if (owns.rows[0]?.owns) throw new Error(`the server's role ${role} owns the tables, or is a member of the role that does: it could lift their triggers`);
    await client.query(`GRANT USAGE ON SCHEMA ${client.escapeIdentifier((await client.query<{ s: string }>("SELECT current_schema() AS s")).rows[0]!.s)} TO ${ident}`);
    for (const g of GRANTS[store.store]) await client.query(g.replace("%R", ident));
    return role;
  } finally {
    client.release();
  }
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
  for (const s of postgresStores(deployment, env, true)) {
    const { store } = s;
    const pool = createPool({ connectionString: s.ownerUrl ?? s.url, max: 1 });
    try {
      let done: MigratedStore;
      if (store === "state.audit") {
        const r = await runMigrations(pool);
        done = { store, applied: r.applied, alreadyApplied: r.alreadyApplied.length };
      } else {
        await migrateWorkflowJournal(pool);
        done = { store, applied: [], alreadyApplied: 0 };
      }
      out.push(s.ownerUrl ? { ...done, runtimeRole: await grantRuntime(pool, s) } : done);
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
      Where a store names an ownerUrl, migrates as that role and grants the server's role (url)
      read and append only, creating it if it does not exist (ADR-0124).

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
          (d.store === "state.workflows"
            ? `${d.store}: the workflow journal's tables are in place`
            : `${d.store}: applied ${d.applied.length ? d.applied.join(", ") : "nothing new"}${d.alreadyApplied ? ` (${d.alreadyApplied} already applied)` : ""}`) +
            (d.runtimeRole ? `; the server's role ${d.runtimeRole} may read and append, nothing more` : "")
        );
    return 0;
  } catch (err) {
    const problems = err instanceof DeploymentError ? err.problems : [reason(err)];
    if (json) console.log(JSON.stringify({ ok: false, problems }));
    else console.error(`FAIL\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }
}
