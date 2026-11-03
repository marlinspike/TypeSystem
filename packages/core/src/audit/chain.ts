import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import type { AuditEvent } from "./audit-log.js";
import type { AuditEventListOptions, RegistryStore } from "../registry/registry-store.js";
import type { QueryResult } from "../model/query.js";
import { canonical } from "../model/canonical.js";

/**
 * A verifiable audit trail (ADR-0105). Every row a writer appends carries the
 * hash of the row before it in that writer's chain, so editing, removing,
 * inserting or reordering a row breaks the chain where it happened. Each
 * process writes its own chain (no lock shared between replicas), and signs
 * its head at intervals: a checkpoint, held apart from the rows, is what lets
 * a verifier tell a chain cut short from one that simply ended.
 */
export const AUDIT_GENESIS = `sha256:${"0".repeat(64)}`;
export const AUDIT_CHECKPOINT_FORMAT = "typesys.audit-checkpoint/1";

/** Where a row sits in its writer's chain. */
export interface AuditLink {
  /** The writer's chain id: one per process lifetime. */
  readonly chain: string;
  /** 1 for the chain's first row, then one more per row. */
  readonly seq: number;
  /** The hash of the row before it in this chain, or `AUDIT_GENESIS` for the first. */
  readonly prev: string;
  /** `sha256:` of the row's canonical form, its link included. */
  readonly hash: string;
}

export interface ChainedAuditEvent {
  readonly event: AuditEvent;
  readonly link: AuditLink;
}

/** A writer's signed statement that its chain had this head at this time. */
export interface AuditCheckpoint {
  readonly chain: string;
  readonly seq: number;
  readonly hash: string;
  readonly at: string;
  readonly keyId: string;
  /** Ed25519 over `checkpointMessage`, base64. */
  readonly signature: string;
}

/** The key a writer signs its checkpoints with. */
export interface AuditSigningKey {
  readonly keyId: string;
  /** An Ed25519 private key, PEM. */
  readonly privateKey: string | KeyObject;
}

/**
 * The event as any store reads it back: a millisecond ISO timestamp, details
 * as JSON round-trips them, and no `undefined` fields. Hashing this form
 * means a row stored and read back hashes the same as the row written.
 */
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const clean = (text: string): string => text.split(NUL).join("\uFFFD").replace(LONE_SURROGATE, "\uFFFD");

/** Strings and keys alike: no store can hold U+0000 or a lone surrogate in text or JSONB. */
function scrub(value: unknown): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) Object.defineProperty(out, clean(k), { value: scrub(v), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return value;
}

/** Fields a store keeps as SQL NULL and reads back absent: null and absent must hash the same. */
const OPTIONAL_FIELDS = ["reason", "outcome", "details", "operation", "build"] as const;
const OPTIONAL_RESOURCE_FIELDS = ["objectId", "propertyPath"] as const;

export function normalizeAuditEvent(event: AuditEvent): AuditEvent {
  const ts = new Date(event.timestamp);
  const json = JSON.stringify({ ...event, timestamp: Number.isNaN(ts.getTime()) ? String(event.timestamp) : ts.toISOString() });
  // One row that cannot be stored must not fail the appends batched with it: unstorable characters become
  // U+FFFD, in the hashed form and the stored form alike.
  const e = scrub(JSON.parse(json)) as Record<string, unknown> & { resource?: Record<string, unknown> };
  for (const f of OPTIONAL_FIELDS) if (e[f] === null) delete e[f];
  if (e.resource && typeof e.resource === "object") for (const f of OPTIONAL_RESOURCE_FIELDS) if (e.resource[f] === null) delete e.resource[f];
  return e as unknown as AuditEvent;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The hash a row with this link and event must carry. */
export function auditLinkHash(chain: string, seq: number, prev: string, event: AuditEvent): string {
  return sha256(canonical({ format: "typesys.audit-row/1", chain, seq, prev, event: normalizeAuditEvent(event) }));
}

/** What a checkpoint's signature covers. */
export function checkpointMessage(cp: Pick<AuditCheckpoint, "chain" | "seq" | "hash" | "at">): Buffer {
  return Buffer.from(canonical({ format: AUDIT_CHECKPOINT_FORMAT, chain: cp.chain, seq: cp.seq, hash: cp.hash, at: cp.at }), "utf8");
}

function privateKeyOf(key: string | KeyObject): KeyObject {
  return typeof key === "string" ? createPrivateKey(key) : key;
}

function publicKeyOf(key: string | KeyObject): KeyObject {
  return typeof key === "string" ? createPublicKey(key) : key;
}

/** Signs a chain head. */
export function signAuditCheckpoint(head: { readonly chain: string; readonly seq: number; readonly hash: string }, key: AuditSigningKey, at: Date = new Date()): AuditCheckpoint {
  const body = { chain: head.chain, seq: head.seq, hash: head.hash, at: at.toISOString() };
  const k = privateKeyOf(key.privateKey);
  if (k.asymmetricKeyType !== "ed25519") throw new TypeError(`Audit checkpoint key ${key.keyId} is not an Ed25519 key`);
  return { ...body, keyId: key.keyId, signature: sign(null, checkpointMessage(body), k).toString("base64") };
}

/** Whether a checkpoint was signed by the key `keys[cp.keyId]` names. */
export function checkpointSignatureValid(cp: AuditCheckpoint, keys: Readonly<Record<string, string | KeyObject>>): "valid" | "invalid" | "unknown-key" {
  if (!Object.hasOwn(keys, cp.keyId)) return "unknown-key";
  try {
    return verify(null, checkpointMessage(cp), publicKeyOf(keys[cp.keyId]!), Buffer.from(cp.signature, "base64")) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/** Where a writer's rows and checkpoints go. A batch is written whole or not at all. */
export interface AuditChainSink {
  write(entries: readonly ChainedAuditEvent[]): Promise<void>;
  writeCheckpoint(cp: AuditCheckpoint): Promise<void>;
  /**
   * The last row stored for a chain. After a write reports failure, the writer
   * asks, because a write can commit and still report failure (a lost COMMIT
   * acknowledgement). A sink without it gets a new chain after any failure.
   */
  headOf?(chain: string): Promise<{ readonly seq: number; readonly hash: string } | undefined>;
}

export interface AuditChainWriterOptions {
  /** Default: a fresh random id. */
  readonly chain?: string;
  /** Sign the head after this many rows since the last checkpoint. Default 1,000; needs `key`. */
  readonly everyRows?: number;
  /** And at least this often while rows are being written, in milliseconds. Default 60,000; needs `key`. */
  readonly everyMs?: number;
  readonly key?: AuditSigningKey;
  readonly now?: () => Date;
}

interface Pending {
  readonly event: AuditEvent;
  resolve(): void;
  reject(err: unknown): void;
}

/**
 * Appends to one chain. Appends made while a write is in flight are batched
 * into the next write, in the order they were made, so a busy process pays
 * one round trip per batch, not per row. A failed write rejects every append
 * in it and leaves the chain where it was: the next batch links to the last
 * row that was written, so a failure never leaves a gap. When the writer
 * cannot tell whether a failed write was stored, it asks the sink for the
 * chain's head, and if the sink cannot say, it starts a new chain: the old one
 * then simply ends, and verifies.
 *
 * With a key, the writer signs an opening checkpoint (seq 0, the genesis hash)
 * before a chain's first row, so a verifier can tell a chain this writer
 * started from one written into the table by anyone else.
 */
export class AuditChainWriter {
  private chainId: string;
  private seq = 0;
  private hash = AUDIT_GENESIS;
  private opened = false;
  private pending: Pending[] = [];
  private flushing: Promise<void> | undefined;
  private sinceCheckpoint = 0;
  private checkpointedSeq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private readonly sink: AuditChainSink,
    private readonly options: AuditChainWriterOptions = {}
  ) {
    this.chainId = options.chain ?? randomUUID();
    if (options.key) {
      const k = privateKeyOf(options.key.privateKey);
      if (k.asymmetricKeyType !== "ed25519") throw new TypeError(`Audit checkpoint key ${options.key.keyId} is not an Ed25519 key`);
      this.timer = setInterval(() => void this.checkpoint().catch(() => undefined), options.everyMs ?? 60_000);
      this.timer.unref?.();
    }
  }

  /** The chain this writer appends to now. It changes only after a write whose outcome could not be known. */
  get chain(): string {
    return this.chainId;
  }

  /** The chain's last written row. */
  get head(): { readonly chain: string; readonly seq: number; readonly hash: string } {
    return { chain: this.chainId, seq: this.seq, hash: this.hash };
  }

  append(event: AuditEvent): Promise<void> {
    if (this.closed) return Promise.reject(new Error("The audit chain is closed"));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ event, resolve, reject });
      // flush() settles every append it takes; the catch only keeps a defect there from killing the process.
      this.flushing ??= this.flush().catch(() => undefined);
    });
  }

  /** Links each pending event after the current head; an event that cannot be hashed is rejected alone. */
  private linkAll(batch: readonly Pending[]): { p: Pending; e: ChainedAuditEvent }[] {
    const out: { p: Pending; e: ChainedAuditEvent }[] = [];
    let seq = this.seq;
    let prev = this.hash;
    for (const p of batch) {
      let e: ChainedAuditEvent;
      try {
        e = { event: p.event, link: { chain: this.chainId, seq: seq + 1, prev, hash: auditLinkHash(this.chainId, seq + 1, prev, p.event) } };
      } catch (err) {
        p.reject(err);
        continue;
      }
      seq += 1;
      prev = e.link.hash;
      out.push({ p, e });
    }
    return out;
  }

  private async open(): Promise<void> {
    if (this.opened) return;
    if (this.options.key) await this.sink.writeCheckpoint(signAuditCheckpoint({ chain: this.chainId, seq: 0, hash: AUDIT_GENESIS }, this.options.key, (this.options.now ?? (() => new Date()))()));
    this.opened = true;
  }

  /** Writes linked entries; true when they are stored, whether or not the write said so. */
  private async store(items: readonly { e: ChainedAuditEvent }[]): Promise<{ ok: true } | { ok: false; err: unknown }> {
    const entries = items.map((i) => i.e);
    const last = entries[entries.length - 1]!.link;
    try {
      await this.open();
      await this.sink.write(entries);
      this.advance(entries.length, last.seq, last.hash);
      return { ok: true };
    } catch (err) {
      if (!this.opened) return { ok: false, err };
      let stored: { readonly seq: number; readonly hash: string } | undefined;
      try {
        if (!this.sink.headOf) throw err;
        stored = await this.sink.headOf(this.chainId);
      } catch {
        await this.rotate();
        return { ok: false, err };
      }
      // A batch is written whole or not at all: either its last row is the stored head, or the head did not move.
      if (stored && stored.seq === last.seq && stored.hash === last.hash) {
        this.advance(entries.length, last.seq, last.hash);
        return { ok: true };
      }
      if ((stored?.seq ?? 0) !== this.seq || (stored?.hash ?? AUDIT_GENESIS) !== this.hash) await this.rotate();
      return { ok: false, err };
    }
  }

  /** Ends this chain where it is known to end, signing that head if it can, and starts a new one. */
  private async rotate(): Promise<void> {
    await this.checkpoint().catch(() => undefined);
    this.chainId = randomUUID();
    this.seq = 0;
    this.hash = AUDIT_GENESIS;
    this.opened = false;
    this.sinceCheckpoint = 0;
    this.checkpointedSeq = 0;
  }

  private async flush(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        const items = this.linkAll(batch);
        if (items.length === 0) continue;
        const r = await this.store(items);
        if (r.ok) for (const { p } of items) p.resolve();
        else if (items.length === 1) items[0]!.p.reject(r.err);
        else {
          // One row that cannot be written must not fail the rows batched with it: write them one at a time.
          for (const { p } of items) {
            const [one] = this.linkAll([p]);
            if (!one) continue;
            const r1 = await this.store([one]);
            if (r1.ok) p.resolve();
            else p.reject(r1.err);
          }
        }
        if (this.options.key && this.sinceCheckpoint >= (this.options.everyRows ?? 1000)) await this.checkpoint().catch(() => undefined);
      }
    } finally {
      this.flushing = undefined;
    }
  }

  private advance(rows: number, seq: number, hash: string): void {
    this.seq = seq;
    this.hash = hash;
    this.sinceCheckpoint += rows;
  }

  /** Signs and writes the current head, if a row was written since the last checkpoint. Needs a key. */
  async checkpoint(): Promise<AuditCheckpoint | undefined> {
    if (!this.options.key || this.seq === 0 || this.seq === this.checkpointedSeq) return undefined;
    const cp = signAuditCheckpoint(this.head, this.options.key, (this.options.now ?? (() => new Date()))());
    await this.sink.writeCheckpoint(cp);
    if (cp.chain !== this.chainId) return cp;
    this.checkpointedSeq = Math.max(this.checkpointedSeq, cp.seq);
    this.sinceCheckpoint = this.seq - this.checkpointedSeq;
    return cp;
  }

  /** Writes what is pending, signs a last checkpoint, and refuses further appends. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.flushing) await this.flushing;
    this.closed = true;
    await this.checkpoint();
  }
}

/** Reads a chained audit log back, for verification and export. */
export interface AuditChainSource {
  /** Every chain id with at least one row or checkpoint. */
  listChains(): Promise<string[]>;
  /** A chain's rows in order, from just after `afterSeq` (default 0), at most `limit`. */
  readChain(chain: string, opts?: { readonly afterSeq?: number; readonly limit?: number }): Promise<ChainedAuditEvent[]>;
  listCheckpoints(chain?: string): Promise<AuditCheckpoint[]>;
  /** Rows written without a chain (before ADR-0105). */
  countUnchained(): Promise<number>;
}

/** The audit half of a registry store: what a chained log replaces. */
export interface AuditLogStore {
  appendAuditEvent(evt: AuditEvent): Promise<void>;
  listAuditEvents(opts?: AuditEventListOptions): Promise<QueryResult<AuditEvent>>;
  close?(): Promise<void>;
}

export type AuditProblemKind =
  /** A row's content no longer hashes to the hash it carries: it was edited. */
  | "altered"
  /** A row does not link to the row before it: one was removed, inserted or moved. */
  | "broken-link"
  /** A sequence number is missing. */
  | "missing"
  /** A chain starts after 1 with no valid checkpoint at its first row or the row before it. */
  | "missing-start"
  /** A checkpoint names a row whose hash is not the one it signed. */
  | "checkpoint-mismatch"
  /** A checkpoint names a row past the chain's end: rows were removed from its tail. */
  | "truncated"
  /** In a signed trail, a chain with no valid checkpoint at all: no writer holding the key started it. */
  | "unsigned-chain"
  | "bad-signature"
  | "unknown-key";

export interface AuditProblem {
  readonly kind: AuditProblemKind;
  readonly chain: string;
  readonly seq?: number;
  readonly message: string;
}

export interface AuditChainSummary {
  readonly chain: string;
  /** First and last row present. */
  readonly from?: number;
  readonly to?: number;
  readonly rows: number;
  /** The highest seq a valid checkpoint covers. */
  readonly anchoredThrough?: number;
  /** Rows after the last valid checkpoint: their removal would not be detectable. */
  readonly unanchored: number;
  readonly builds: readonly string[];
}

export interface AuditVerification {
  readonly ok: boolean;
  readonly rows: number;
  readonly unchained: number;
  readonly chains: readonly AuditChainSummary[];
  readonly problems: readonly AuditProblem[];
}

/**
 * Walks every chain from its start and checks each row's hash, each link,
 * each sequence number and each checkpoint. A chain may start after 1 only
 * where a valid checkpoint signs its first row or the row before it
 * (pruned by retention behind a checkpoint, ADR-0105).
 */
export async function verifyAuditLog(source: AuditChainSource, keys: Readonly<Record<string, string | KeyObject>>, opts: { readonly pageSize?: number } = {}): Promise<AuditVerification> {
  const pageSize = opts.pageSize ?? 1000;
  const problems: AuditProblem[] = [];
  const summaries: AuditChainSummary[] = [];
  let total = 0;
  const allCheckpoints = await source.listCheckpoints();
  const chains = [...new Set([...(await source.listChains()), ...allCheckpoints.map((c) => c.chain)])].sort();
  for (const chain of chains) {
    const validCps = new Map<number, AuditCheckpoint>();
    for (const cp of allCheckpoints.filter((c) => c.chain === chain)) {
      const sig = checkpointSignatureValid(cp, keys);
      if (sig === "valid") validCps.set(cp.seq, cp);
      else problems.push({ kind: sig === "unknown-key" ? "unknown-key" : "bad-signature", chain, seq: cp.seq, message: sig === "unknown-key" ? `checkpoint at ${cp.seq} is signed by unknown key ${cp.keyId}` : `checkpoint at ${cp.seq} has a signature that does not verify under ${cp.keyId}` });
    }
    let after = 0;
    let expectedSeq: number | undefined;
    let prevHash: string | undefined;
    let from: number | undefined;
    let to: number | undefined;
    let rows = 0;
    const builds = new Set<string>();
    const hashes = new Map<number, string>();
    for (;;) {
      const page = await source.readChain(chain, { afterSeq: after, limit: pageSize });
      for (const { event, link } of page) {
        rows += 1;
        if (event.build) builds.add(event.build);
        if (from === undefined) {
          from = link.seq;
          if (link.seq !== 1) {
            // Pruned by retention (ADR-0105): the first row left links to a signed checkpoint before it, or is itself the signed one.
            const before = validCps.get(link.seq - 1);
            const own = validCps.get(link.seq);
            if (!(before && before.hash === link.prev) && !(own && own.hash === link.hash))
              problems.push({ kind: "missing-start", chain, seq: link.seq, message: `the chain starts at ${link.seq} with no valid checkpoint at ${link.seq - 1} or ${link.seq} to anchor it` });
          } else if (link.prev !== AUDIT_GENESIS) problems.push({ kind: "broken-link", chain, seq: 1, message: "the first row does not start the chain" });
        } else {
          if (link.seq !== expectedSeq) problems.push({ kind: "missing", chain, seq: expectedSeq!, message: `rows ${expectedSeq}..${link.seq - 1} are missing` });
          else if (link.prev !== prevHash) problems.push({ kind: "broken-link", chain, seq: link.seq, message: `row ${link.seq} does not link to row ${link.seq - 1}` });
        }
        const actual = auditLinkHash(link.chain, link.seq, link.prev, event);
        if (actual !== link.hash) problems.push({ kind: "altered", chain, seq: link.seq, message: `row ${link.seq} (${event.id}) was changed after it was written` });
        hashes.set(link.seq, link.hash);
        prevHash = link.hash;
        expectedSeq = link.seq + 1;
        to = link.seq;
        after = link.seq;
      }
      if (page.length < pageSize) break;
    }
    total += rows;
    let anchoredThrough: number | undefined;
    for (const [seq, cp] of [...validCps].sort(([a], [b]) => a - b)) {
      // The opening checkpoint (ADR-0105): the writer started this chain, at the genesis hash.
      if (seq === 0) {
        if (cp.hash !== AUDIT_GENESIS) problems.push({ kind: "checkpoint-mismatch", chain, seq, message: "the chain's opening checkpoint does not sign the genesis hash" });
        else anchoredThrough = Math.max(anchoredThrough ?? 0, 0);
        continue;
      }
      if (from !== undefined && seq === from - 1) {
        anchoredThrough = Math.max(anchoredThrough ?? 0, seq);
        continue;
      }
      if (to === undefined || seq > to) problems.push({ kind: "truncated", chain, seq, message: `a checkpoint covers row ${seq}, but the chain ends at ${to ?? "nothing"}: rows were removed from its end` });
      else if (from !== undefined && seq < from) continue;
      else if (hashes.get(seq) !== cp.hash) problems.push({ kind: "checkpoint-mismatch", chain, seq, message: `row ${seq} is not the row the checkpoint signed` });
      else anchoredThrough = Math.max(anchoredThrough ?? 0, seq);
    }
    // Anyone who may insert rows can compute their hashes; only the key holder can sign. In a signed trail a chain
    // nobody signed, not even its opening, is rows of unknown origin.
    if (Object.keys(keys).length > 0 && rows > 0 && validCps.size === 0 && !allCheckpoints.some((c) => c.chain === chain))
      problems.push({ kind: "unsigned-chain", chain, message: `${rows} row${rows === 1 ? "" : "s"} in a chain no key signed: not written by a signing writer` });
    summaries.push({
      chain,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      rows,
      ...(anchoredThrough !== undefined ? { anchoredThrough } : {}),
      unanchored: to === undefined ? 0 : to - Math.max(anchoredThrough ?? 0, (from ?? 1) - 1),
      builds: [...builds].sort()
    });
  }
  return { ok: problems.length === 0, rows: total, unchained: await source.countUnchained(), chains: summaries, problems };
}

/**
 * A chained audit log in this process: what a deployment without durable
 * state gets, so the same verification holds while it runs.
 */
export class InMemoryAuditLog implements AuditLogStore, AuditChainSource {
  private readonly rows: ChainedAuditEvent[] = [];
  private readonly checkpoints: AuditCheckpoint[] = [];
  readonly writer: AuditChainWriter;

  constructor(options: AuditChainWriterOptions = {}) {
    this.writer = new AuditChainWriter(
      {
        write: async (entries) => void this.rows.push(...entries.map((e) => ({ event: normalizeAuditEvent(e.event), link: e.link }))),
        writeCheckpoint: async (cp) => void this.checkpoints.push(cp)
      },
      options
    );
  }

  appendAuditEvent(evt: AuditEvent): Promise<void> {
    return this.writer.append(evt);
  }

  async listAuditEvents(opts: AuditEventListOptions = {}): Promise<QueryResult<AuditEvent>> {
    const { limit = 100, before, action } = opts;
    const newestFirst = this.rows.map((r) => r.event).reverse().filter((e) => action === undefined || e.action === action);
    const startIndex = before ? newestFirst.findIndex((e) => e.id === before) + 1 : 0;
    const page = newestFirst.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < newestFirst.length ? page[page.length - 1]?.id : undefined;
    return { items: page, nextCursor };
  }

  async listChains(): Promise<string[]> {
    return [...new Set(this.rows.map((r) => r.link.chain))];
  }

  async readChain(chain: string, opts: { readonly afterSeq?: number; readonly limit?: number } = {}): Promise<ChainedAuditEvent[]> {
    return this.rows.filter((r) => r.link.chain === chain && r.link.seq > (opts.afterSeq ?? 0)).sort((a, b) => a.link.seq - b.link.seq).slice(0, opts.limit ?? 1000);
  }

  async listCheckpoints(chain?: string): Promise<AuditCheckpoint[]> {
    return this.checkpoints.filter((c) => chain === undefined || c.chain === chain);
  }

  async countUnchained(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}

/**
 * A registry store whose audit rows go to `audit` while the model stays in
 * `model`: how a host keeps its model in-process (ADR-0102) and its audit
 * trail durable and shared (ADR-0106).
 */
export function withAuditLog(model: RegistryStore, audit: AuditLogStore): RegistryStore {
  return {
    putType: (d) => model.putType(d),
    getType: (n, r) => model.getType(n, r),
    listTypeVersions: (n) => model.listTypeVersions(n),
    listTypes: () => model.listTypes(),
    putRelationship: (d) => model.putRelationship(d),
    listRelationships: (t) => model.listRelationships(t),
    putAction: (d) => model.putAction(d),
    getAction: (n, r) => model.getAction(n, r),
    listActions: () => model.listActions(),
    putDataSource: (d) => model.putDataSource(d),
    getDataSource: (id) => model.getDataSource(id),
    putMapping: (m) => model.putMapping(m),
    listMappings: (t) => model.listMappings(t),
    appendAuditEvent: (e) => audit.appendAuditEvent(e),
    listAuditEvents: (o) => audit.listAuditEvents(o),
    async close() {
      const results = await Promise.allSettled([audit.close?.(), model.close?.()]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    }
  };
}
