import { generateKeyPairSync } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { ulid } from "ulid";
import { createPool, PostgresAuditLog } from "@typesys/registry-store-postgres";
import {
  verifyAuditLog,
  type AuditChainSource,
  type AuditCheckpoint,
  type AuditVerification,
  type ChainedAuditEvent
} from "@typesys/core";
import { DeploymentError, type Credential, type Deployment } from "./deployment.js";
import { processEnvironment, type HostEnvironment } from "./host.js";
import { loadDeployment } from "./load.js";
import { auditSigningKey } from "./state.js";

export const AUDIT_EXPORT_FORMAT = "typesys.audit-export/1";

const USAGE = `typesys audit — verify, export and prune a deployment's audit trail (ADR-0105)

  typesys audit verify <deployment.json> [--json]
      Walk every chain in the deployment's audit trail (state.audit) from its start and check
      each row's hash, each link, each sequence number and each signed checkpoint against
      state.audit.verifyKeys. Exits 1 on any row edited, removed, inserted or reordered, or any
      checkpoint that does not verify.
  typesys audit verify --file <export.jsonl> <deployment.json> [--json]
      The same over an export, with the deployment's verify keys.
  typesys audit export <deployment.json> [--chain <id>]... [--out <file>]
      Write the trail (or the chains named) with their checkpoints as JSON lines that
      'audit verify --file' checks offline.
  typesys audit keygen --key-id <id> [--out-dir <dir>]
      Make an Ed25519 key for signing checkpoints: the private key goes in the secret
      state.audit.signing.key names, the public key in state.audit.verifyKeys.
  typesys audit prune <deployment.json> [--before <ISO time>] [--json]
      Delete rows older than state.audit.retainDays (or --before), each chain only up to a signed
      checkpoint, so what remains still verifies. The prune itself is audited.

The database URL and signing key come from the environment, as the deployment's $secret
references name them.
`;

/** An export read back: a chain source over its lines. */
export async function readAuditExport(file: string): Promise<AuditChainSource> {
  const rows: ChainedAuditEvent[] = [];
  const checkpoints: AuditCheckpoint[] = [];
  let unchained = 0;
  let header = false;
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const v = JSON.parse(line) as { format?: string; row?: ChainedAuditEvent; checkpoint?: AuditCheckpoint; unchained?: number };
    if (!header) {
      if (v.format !== AUDIT_EXPORT_FORMAT) throw new Error(`${file}: not a ${AUDIT_EXPORT_FORMAT} export`);
      header = true;
      unchained = v.unchained ?? 0;
      continue;
    }
    if (v.row) rows.push(v.row);
    else if (v.checkpoint) checkpoints.push(v.checkpoint);
  }
  if (!header) throw new Error(`${file}: empty`);
  return {
    listChains: async () => [...new Set(rows.map((r) => r.link.chain))].sort(),
    readChain: async (chain, o = {}) => rows.filter((r) => r.link.chain === chain && r.link.seq > (o.afterSeq ?? 0)).sort((a, b) => a.link.seq - b.link.seq).slice(0, o.limit ?? 1000),
    listCheckpoints: async (chain) => checkpoints.filter((c) => chain === undefined || c.chain === chain),
    countUnchained: async () => unchained
  };
}

function resolver(deployment: Deployment, env: HostEnvironment) {
  return (value: Credential, at: string): string => {
    if (typeof value === "string") return value;
    const v = env.secret(value.$secret) ?? (deployment.demo ? value.default : undefined);
    if (v === undefined || v === "") throw new DeploymentError([`${at}: secret ${value.$secret} is not set`]);
    return `${value.prefix ?? ""}${v}`;
  };
}

function postgresAudit(deployment: Deployment, env: HostEnvironment): { log: PostgresAuditLog; close(): Promise<void> } {
  const a = deployment.state?.audit;
  if (a?.kind !== "postgres") throw new DeploymentError([`${deployment.name}: state.audit is not postgres: its trail is kept in the serving process and goes with it`]);
  const pool = createPool({ connectionString: resolver(deployment, env)(a.url, "state.audit.url"), max: 2 });
  return { log: new PostgresAuditLog(pool), close: () => pool.end() };
}

function render(v: AuditVerification): string {
  const lines = [v.ok ? `OK: ${v.rows} rows in ${v.chains.length} chain${v.chains.length === 1 ? "" : "s"} verify.` : `FAILED: ${v.problems.length} problem${v.problems.length === 1 ? "" : "s"} in the audit trail.`];
  for (const p of v.problems) lines.push(`  ✗ [${p.kind}] chain ${p.chain}${p.seq !== undefined ? ` row ${p.seq}` : ""}: ${p.message}`);
  for (const c of v.chains) {
    const range = c.from === undefined ? "no rows" : `rows ${c.from}..${c.to}`;
    const anchored = c.anchoredThrough === undefined ? "no valid checkpoint" : `signed through ${c.anchoredThrough}`;
    lines.push(`  chain ${c.chain}: ${range}, ${anchored}${c.unanchored ? `, ${c.unanchored} unanchored (their removal would not be detected)` : ""}${c.builds.length ? `, build ${c.builds.map((b) => b.slice(0, 19)).join(", ")}` : ""}`);
  }
  if (v.unchained) lines.push(`  ${v.unchained} rows were written before chaining (ADR-0105) and are not covered.`);
  return `${lines.join("\n")}\n`;
}

interface Args {
  positionals: string[];
  chains: string[];
  json: boolean;
  file?: string;
  out?: string;
  before?: string;
  keyId?: string;
  outDir?: string;
}

function parse(argv: readonly string[]): Args {
  const out: Args = { positionals: [], chains: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--json") out.json = true;
    else if (a === "--file") out.file = next();
    else if (a === "--out") out.out = next();
    else if (a === "--chain") out.chains.push(next());
    else if (a === "--before") out.before = next();
    else if (a === "--key-id") out.keyId = next();
    else if (a === "--out-dir") out.outDir = next();
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else out.positionals.push(a);
  }
  return out;
}

/** `typesys audit ...`: the exit code. `env` is where `$secret` references resolve (default the process environment). */
export async function auditCommand(argv: readonly string[], env: HostEnvironment = processEnvironment): Promise<number> {
  const [sub, ...rest] = argv;
  let args: Args;
  try {
    args = parse(rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const fail = (err: unknown): number => {
    const problems = err instanceof DeploymentError ? err.problems : [err instanceof Error ? err.message : String(err)];
    if (args.json) console.log(JSON.stringify({ ok: false, problems }));
    else console.error(`FAIL\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  };
  if (sub === "keygen") {
    if (!args.keyId || !/^[A-Za-z0-9._-]+$/.test(args.keyId)) {
      console.error("typesys audit keygen needs --key-id <id> (letters, digits, '.', '_' and '-')");
      return 2;
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    if (args.outDir) {
      const privFile = path.join(args.outDir, `${args.keyId}.private.pem`);
      const pubFile = path.join(args.outDir, `${args.keyId}.public.pem`);
      await writeFile(privFile, priv, { mode: 0o600, flag: "wx" });
      await writeFile(pubFile, pub, { flag: "wx" });
      console.log(`wrote ${privFile} (put it in the secret state.audit.signing.key names) and ${pubFile}`);
    }
    console.log(JSON.stringify({ signing: { keyId: args.keyId, key: { $secret: "AUDIT_SIGNING_KEY" } }, verifyKeys: { [args.keyId]: pub } }, null, 2));
    if (!args.outDir) process.stderr.write(`\nThe private key, for the AUDIT_SIGNING_KEY secret (shown once, never stored):\n${priv}`);
    return 0;
  }
  if (args.positionals.length !== 1 || !["verify", "export", "prune"].includes(sub ?? "")) {
    console.error(USAGE);
    return sub === undefined || sub === "help" || sub === "--help" ? 0 : 2;
  }
  try {
    const { deployment } = await loadDeployment(args.positionals[0]!);
    const keys = deployment.state?.audit?.verifyKeys ?? {};
    if (sub === "verify") {
      let v: AuditVerification;
      if (args.file) v = await verifyAuditLog(await readAuditExport(args.file), keys);
      else {
        const pg = postgresAudit(deployment, env);
        try {
          v = await verifyAuditLog(pg.log, keys);
        } finally {
          await pg.close();
        }
      }
      if (args.json) console.log(JSON.stringify(v));
      else (v.ok ? process.stdout : process.stderr).write(render(v));
      return v.ok ? 0 : 1;
    }
    const pg = postgresAudit(deployment, env);
    try {
      if (sub === "export") {
        const chains = args.chains.length ? args.chains : await pg.log.listChains();
        const lines = [JSON.stringify({ format: AUDIT_EXPORT_FORMAT, deployment: deployment.name, exportedAt: new Date().toISOString(), unchained: args.chains.length ? 0 : await pg.log.countUnchained() })];
        let rows = 0;
        for (const chain of chains) {
          let after = 0;
          for (;;) {
            const page = await pg.log.readChain(chain, { afterSeq: after, limit: 1000 });
            for (const r of page) lines.push(JSON.stringify({ row: r }));
            rows += page.length;
            if (page.length < 1000) break;
            after = page.at(-1)!.link.seq;
          }
          for (const cp of await pg.log.listCheckpoints(chain)) lines.push(JSON.stringify({ checkpoint: cp }));
        }
        const text = `${lines.join("\n")}\n`;
        if (args.out) {
          await writeFile(args.out, text);
          console.error(`exported ${rows} rows of ${chains.length} chain${chains.length === 1 ? "" : "s"} to ${args.out}`);
        } else process.stdout.write(text);
        return 0;
      }
      // prune
      const days = deployment.state?.audit?.kind === "postgres" ? deployment.state.audit.retainDays : undefined;
      if (!args.before && days === undefined) throw new DeploymentError(["state.audit.retainDays: the deployment keeps its audit trail forever; give --before to prune anyway"]);
      const cutoff = args.before ? new Date(args.before) : new Date(Date.now() - days! * 86_400_000);
      if (Number.isNaN(cutoff.getTime())) throw new Error(`--before: ${args.before} is not a time`);
      const result = await pg.log.prune(cutoff);
      // The prune is itself audited, on a chain of its own, signed when the deployment's key is at hand.
      let key;
      try {
        key = auditSigningKey(deployment.state?.audit, resolver(deployment, env));
      } catch {
        key = undefined;
      }
      const recorder = new PostgresAuditLog(createPool({ connectionString: resolver(deployment, env)((deployment.state!.audit as { url: Credential }).url, "state.audit.url"), max: 1 }), { ...(key ? { key } : {}), ownsPool: true });
      await recorder.appendAuditEvent({
        id: ulid(),
        timestamp: new Date().toISOString(),
        subjectId: "typesys-audit-prune",
        action: "audit.prune",
        resource: { typeName: "audit" },
        decision: "allow",
        outcome: "success",
        details: { before: cutoff.toISOString(), deleted: result.deleted, chains: result.chains.map((c) => ({ chain: c.chain, through: c.through, deleted: c.deleted })) }
      });
      await recorder.close();
      if (args.json) console.log(JSON.stringify({ ok: true, before: cutoff.toISOString(), ...result }));
      else console.log(`pruned ${result.deleted} rows written before ${cutoff.toISOString()} from ${result.chains.length} chain${result.chains.length === 1 ? "" : "s"}; each still verifies from its checkpoint`);
      return 0;
    } finally {
      await pg.close();
    }
  } catch (err) {
    return fail(err);
  }
}
