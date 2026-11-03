/**
 * The verifiable audit trail end to end (ADR-0105, ADR-0106), against a real
 * Postgres (DATABASE_URL), in a schema of its own that it drops when done:
 *
 *   npm run audit:demo
 *
 * The airforce demonstration is deployed with its audit trail kept in
 * Postgres and signed with a key made for the run. It serves reads as the
 * maintainer, the viewer and an anonymous caller, restarts (a new chain),
 * serves again, and `typesys audit verify` checks every row. Then someone
 * with the table owner's credentials lifts the trigger and rewrites the
 * viewer's refusal as an allow, and verify names the row.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { corePack } from "@typesys/packs";
import { airforcePack } from "@typesys/domain-airforce";
import { airforceDeployment, airforceExtension } from "@typesys/demo-web/deployments";
import { runMigrations } from "@typesys/registry-store-postgres";
import { auditCommand, buildHost, emptyEnvironment, overlayEnvironment, type Deployment } from "@typesys/host";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("npm run audit:demo needs DATABASE_URL (a Postgres it may create a schema in)");
  process.exit(2);
}

const schema = `audit_demo_${Date.now()}`;
const url = new URL(DATABASE_URL);
url.searchParams.set("options", `-c search_path=${schema}`);
const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
const dir = await mkdtemp(path.join(os.tmpdir(), "typesys-audit-demo-"));
const step = (s: string) => console.log(`\n== ${s}`);

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const p = new pg.Pool({ connectionString: url.href, max: 1 });
  await runMigrations(p);
  await p.end();

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const deployment: Deployment = {
    ...airforceDeployment,
    state: {
      audit: {
        kind: "postgres",
        url: { $secret: "DATABASE_URL" },
        signing: { keyId: "audit-demo", key: { $secret: "AUDIT_SIGNING_KEY" }, everyRows: 10 },
        verifyKeys: { "audit-demo": publicKey.export({ type: "spki", format: "pem" }).toString() },
        retainDays: 400
      }
    }
  };
  const file = path.join(dir, "airforce.deployment.json");
  await writeFile(file, JSON.stringify({ ...deployment, packs: deployment.packs.map((x) => ({ ...x, file: path.join(root, "packs", `${x.name}-${x.version}.typesys-pack.json`) })) }, null, 2));
  const env = overlayEnvironment({ DATABASE_URL: url.href, AUDIT_SIGNING_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, emptyEnvironment);
  const boot = () => buildHost(deployment, { packs: [corePack, airforcePack], extensions: [airforceExtension], env });

  step("Deploy, with the audit trail in Postgres and signed checkpoints (state.audit)");
  let host = await boot();
  console.log(`build ${host.build.slice(0, 19)}…, audit chain ${host.state.audit.chain}`);
  for (const [who, token] of [["maintainer", "demo-maintainer-token"], ["viewer", "demo-viewer-token"], ["anonymous", ""]] as const) {
    const identity = await host.identityResolver(token);
    const got = await host.runtime.getObject("airforce.Aircraft", "AF86-0147", identity).then(
      (o) => `${Object.keys(o.values).length} values`,
      (e: unknown) => (e as Error).message
    );
    console.log(`  ${who.padEnd(10)} reads AF86-0147: ${got}`);
  }

  step("Restart: a rolling upgrade, as kubectl rollout restart does it");
  await host.close();
  host = await boot();
  console.log(`audit chain ${host.state.audit.chain} (a new process writes a new chain; the old one is still there)`);
  await host.runtime.getObject("airforce.Aircraft", "AF86-0147", await host.identityResolver("demo-lead-token"));
  await host.close();

  step("typesys audit verify");
  await auditCommand(["verify", file], env);

  step("Someone with the table owner's credentials rewrites the viewer's refusal as an allow");
  const tamper = new pg.Pool({ connectionString: url.href, max: 1 });
  const { rows } = await tamper.query<{ id: string; resource_property_path: string }>(
    `SELECT id, resource_property_path FROM audit_events WHERE subject_id = 'user-viewer-1' AND decision = 'deny' ORDER BY seq LIMIT 1`
  );
  console.log(`  ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update; UPDATE ... SET decision = 'allow' WHERE id = '${rows[0]!.id}' (${rows[0]!.resource_property_path})`);
  await tamper.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update");
  await tamper.query("UPDATE audit_events SET decision = 'allow', reason = NULL WHERE id = $1", [rows[0]!.id]);
  await tamper.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update");
  await tamper.end();

  step("typesys audit verify, again");
  const code = await auditCommand(["verify", file], env);
  console.log(`exit ${code}`);
  if (code !== 1) throw new Error("verify should have failed on the edited row");
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
}
