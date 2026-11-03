import type { Pool } from "pg";
import {
  AuditChainWriter,
  normalizeAuditEvent,
  type AuditChainSource,
  type AuditChainWriterOptions,
  type AuditCheckpoint,
  type AuditEvent,
  type AuditEventListOptions,
  type AuditLogStore,
  type ChainedAuditEvent,
  type QueryResult
} from "@typesys/core";
import { listAuditRows } from "./postgres-registry-store.js";
import { auditEventRowToEvent, toJsonParam, type AuditEventRow } from "./serialization.js";

interface ChainedRow extends AuditEventRow {
  chain: string;
  seq: string;
  prev_hash: string;
  hash: string;
}

interface CheckpointRow {
  chain: string;
  seq: string;
  hash: string;
  at: string;
  key_id: string;
  signature: string;
}

const COLUMNS = 17;

function checkpointOf(r: CheckpointRow): AuditCheckpoint {
  return { chain: r.chain, seq: Number(r.seq), hash: r.hash, at: r.at, keyId: r.key_id, signature: r.signature };
}

export interface PruneResult {
  /** Rows deleted, per chain, and the checkpointed row each chain now starts at. */
  readonly chains: readonly { readonly chain: string; readonly through: number; readonly deleted: number }[];
  readonly deleted: number;
}

/**
 * The audit trail in Postgres as a chain (ADR-0105): `audit_events` rows that
 * each carry this writer's chain id, sequence number, previous hash and own
 * hash, and signed heads in `audit_checkpoints`. Every replica writes its own
 * chain, so appends take no lock another replica waits on; a batch is one
 * INSERT. Run the package's migrations (0008 and later) first.
 */
export class PostgresAuditLog implements AuditLogStore, AuditChainSource {
  readonly writer: AuditChainWriter;

  constructor(
    private readonly pool: Pool,
    options: AuditChainWriterOptions & { readonly ownsPool?: boolean } = {}
  ) {
    this.ownsPool = options.ownsPool ?? false;
    this.writer = new AuditChainWriter({ write: (e) => this.write(e), writeCheckpoint: (c) => this.writeCheckpoint(c), headOf: (c) => this.headOf(c) }, options);
  }

  private readonly ownsPool: boolean;

  private async write(entries: readonly ChainedAuditEvent[]): Promise<void> {
    const values: unknown[] = [];
    const tuples = entries.map(({ event, link }, i) => {
      // The stored form is the hashed form: what is read back hashes to what was written.
      const e = normalizeAuditEvent(event);
      values.push(
        e.id,
        e.timestamp,
        e.subjectId,
        e.action,
        e.resource.typeName,
        e.resource.objectId ?? null,
        e.resource.propertyPath ?? null,
        e.decision,
        e.reason ?? null,
        e.outcome ?? null,
        toJsonParam(e.details),
        e.operation ?? null,
        e.build ?? null,
        link.chain,
        link.seq,
        link.prev,
        link.hash
      );
      return `(${Array.from({ length: COLUMNS }, (_, j) => `$${i * COLUMNS + j + 1}`).join(", ")})`;
    });
    await this.pool.query(
      `INSERT INTO audit_events (id, "timestamp", subject_id, action, resource_type_name, resource_object_id,
                                 resource_property_path, decision, reason, outcome, details, operation, build,
                                 chain, seq, prev_hash, hash)
       VALUES ${tuples.join(", ")}`,
      values
    );
  }

  private async writeCheckpoint(cp: AuditCheckpoint): Promise<void> {
    const r = await this.pool.query(`INSERT INTO audit_checkpoints (chain, seq, hash, at, key_id, signature) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [
      cp.chain,
      cp.seq,
      cp.hash,
      cp.at,
      cp.keyId,
      cp.signature
    ]);
    if (r.rowCount === 1) return;
    // A row already there is ours only if it signs the same head (a retried write whose first try committed).
    const { rows } = await this.pool.query<{ hash: string }>(`SELECT hash FROM audit_checkpoints WHERE chain = $1 AND seq = $2`, [cp.chain, cp.seq]);
    if (rows[0]?.hash !== cp.hash) throw new Error(`audit_checkpoints already holds a different checkpoint at ${cp.chain}:${cp.seq}`);
  }

  private async headOf(chain: string): Promise<{ seq: number; hash: string } | undefined> {
    const { rows } = await this.pool.query<{ seq: string; hash: string }>(`SELECT seq, hash FROM audit_events WHERE chain = $1 ORDER BY seq DESC LIMIT 1`, [chain]);
    return rows[0] ? { seq: Number(rows[0].seq), hash: rows[0].hash } : undefined;
  }

  appendAuditEvent(evt: AuditEvent): Promise<void> {
    return this.writer.append(evt);
  }

  listAuditEvents(opts: AuditEventListOptions = {}): Promise<QueryResult<AuditEvent>> {
    return listAuditRows(this.pool, opts);
  }

  async listChains(): Promise<string[]> {
    const { rows } = await this.pool.query<{ chain: string }>(
      `SELECT chain FROM audit_events WHERE chain IS NOT NULL UNION SELECT chain FROM audit_checkpoints ORDER BY chain`
    );
    return rows.map((r) => r.chain);
  }

  async readChain(chain: string, opts: { readonly afterSeq?: number; readonly limit?: number } = {}): Promise<ChainedAuditEvent[]> {
    const { rows } = await this.pool.query<ChainedRow>(`SELECT * FROM audit_events WHERE chain = $1 AND seq > $2 ORDER BY seq LIMIT $3`, [chain, opts.afterSeq ?? 0, opts.limit ?? 1000]);
    return rows.map((r) => ({ event: auditEventRowToEvent(r), link: { chain: r.chain, seq: Number(r.seq), prev: r.prev_hash, hash: r.hash } }));
  }

  async listCheckpoints(chain?: string): Promise<AuditCheckpoint[]> {
    const { rows } = chain === undefined
      ? await this.pool.query<CheckpointRow>(`SELECT * FROM audit_checkpoints ORDER BY chain, seq`)
      : await this.pool.query<CheckpointRow>(`SELECT * FROM audit_checkpoints WHERE chain = $1 ORDER BY seq`, [chain]);
    return rows.map(checkpointOf);
  }

  async countUnchained(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM audit_events WHERE chain IS NULL`);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Deletes rows written before `cutoff`, chain by chain, up to (not
   * including) the latest checkpointed row that is itself older than
   * `cutoff`. That row is kept: its checkpoint signs it, so the chain still
   * verifies from it, and a chain pruned whole can still be told from one
   * deleted (its checkpoints would name rows that are gone). Rows written before chaining
   * (ADR-0105) are never pruned. One transaction.
   */
  async prune(cutoff: Date): Promise<PruneResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL typesys.audit_prune = 'on'");
      const { rows: targets } = await client.query<{ chain: string; through: string }>(
        `SELECT c.chain, max(c.seq) AS through
           FROM audit_checkpoints c
           JOIN audit_events e ON e.chain = c.chain AND e.seq = c.seq
          WHERE e."timestamp" < $1
          GROUP BY c.chain
          ORDER BY c.chain`,
        [cutoff.toISOString()]
      );
      const chains: { chain: string; through: number; deleted: number }[] = [];
      for (const t of targets) {
        const r = await client.query(`DELETE FROM audit_events WHERE chain = $1 AND seq < $2`, [t.chain, t.through]);
        chains.push({ chain: t.chain, through: Number(t.through), deleted: r.rowCount ?? 0 });
      }
      await client.query("COMMIT");
      return { chains: chains.filter((c) => c.deleted > 0), deleted: chains.reduce((n, c) => n + c.deleted, 0) };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } finally {
      if (this.ownsPool) await this.pool.end();
    }
  }
}
