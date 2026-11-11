import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../src/audit/audit-log.js";
import {
  AUDIT_GENESIS,
  AuditChainWriter,
  InMemoryAuditLog,
  auditLinkHash,
  parseAuditWitness,
  signAuditCheckpoint,
  verifyAuditLog,
  withAuditLog,
  type AuditChainSource,
  type AuditCheckpoint,
  type ChainedAuditEvent
} from "../src/audit/chain.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const keys = { k1: pem };
const key = { keyId: "k1", privateKey };

function event(i: number, extra: Partial<AuditEvent> = {}): AuditEvent {
  return { id: `evt-${i}`, timestamp: new Date(Date.UTC(2026, 10, 3, 9, 0, i)).toISOString(), subjectId: "u1", action: "read", resource: { typeName: "airforce.Aircraft", objectId: `AF-${i}` }, decision: "allow", details: { n: i }, ...extra };
}

/** A chain source over plain arrays, so a test can tamper with what a store would hold. */
function source(rows: ChainedAuditEvent[], checkpoints: AuditCheckpoint[]): AuditChainSource {
  return {
    listChains: async () => [...new Set(rows.map((r) => r.link.chain))],
    readChain: async (chain, o = {}) => rows.filter((r) => r.link.chain === chain && r.link.seq > (o.afterSeq ?? 0)).sort((a, b) => a.link.seq - b.link.seq).slice(0, o.limit ?? 1000),
    listCheckpoints: async () => checkpoints,
    countUnchained: async () => 0
  };
}

async function written(n: number, opts: { everyRows?: number } = {}): Promise<{ rows: ChainedAuditEvent[]; checkpoints: AuditCheckpoint[]; writer: AuditChainWriter }> {
  const rows: ChainedAuditEvent[] = [];
  const checkpoints: AuditCheckpoint[] = [];
  const writer = new AuditChainWriter({ write: async (e) => void rows.push(...e), writeCheckpoint: async (c) => void checkpoints.push(c) }, { chain: "c1", key, everyRows: opts.everyRows ?? 1000 });
  for (let i = 1; i <= n; i++) await writer.append(event(i));
  await writer.close();
  return { rows, checkpoints, writer };
}

describe("audit chain (ADR-0105)", () => {
  it("links every row to the one before and verifies untouched", async () => {
    const { rows, checkpoints } = await written(25, { everyRows: 10 });
    expect(rows.map((r) => r.link.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(rows[0]!.link.prev).toBe(AUDIT_GENESIS);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.link.prev).toBe(rows[i - 1]!.link.hash);
    expect(checkpoints.at(-1)!.seq).toBe(25);
    const v = await verifyAuditLog(source(rows, checkpoints), keys);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.chains[0]).toMatchObject({ chain: "c1", from: 1, to: 25, rows: 25, anchoredThrough: 25, unanchored: 0 });
  });

  it("batches appends made while a write is in flight, in order", async () => {
    const batches: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const writer = new AuditChainWriter({
      write: async (e) => {
        batches.push(e.length);
        if (batches.length === 1) await gate;
      },
      writeCheckpoint: async () => undefined
    });
    const first = writer.append(event(1));
    const rest = [2, 3, 4].map((i) => writer.append(event(i)));
    release();
    await Promise.all([first, ...rest]);
    expect(batches).toEqual([1, 3]);
    expect(writer.head.seq).toBe(4);
  });

  it("a failed write rejects its appends and leaves no gap", async () => {
    const rows: ChainedAuditEvent[] = [];
    let fail = true;
    const writer = new AuditChainWriter({
      write: async (e) => {
        if (fail) {
          fail = false;
          throw new Error("db down");
        }
        rows.push(...e);
      },
      writeCheckpoint: async () => undefined,
      // The sink can say what it holds, so the writer knows the failed write stored nothing and keeps its chain.
      headOf: async () => (rows.length ? { seq: rows[rows.length - 1]!.link.seq, hash: rows[rows.length - 1]!.link.hash } : undefined)
    }, { chain: "c1" });
    await expect(writer.append(event(1))).rejects.toThrow("db down");
    await writer.append(event(2));
    expect(rows.map((r) => [r.link.chain, r.link.seq])).toEqual([["c1", 1]]);
    expect((await verifyAuditLog(source(rows, []), {})).ok).toBe(true);
  });

  it("detects an edited row", async () => {
    const { rows, checkpoints } = await written(5);
    rows[2] = { ...rows[2]!, event: { ...rows[2]!.event, decision: "deny" } };
    const v = await verifyAuditLog(source(rows, checkpoints), keys);
    expect(v.ok).toBe(false);
    expect(v.problems.map((p) => [p.kind, p.seq])).toContainEqual(["altered", 3]);
  });

  it("detects an edit to a detail, even one re-hashed into its own row", async () => {
    const { rows, checkpoints } = await written(5);
    const e = { ...rows[1]!.event, details: { n: 99 } };
    // The forger recomputes the edited row's own hash: the next row no longer links to it.
    rows[1] = { event: e, link: { ...rows[1]!.link, hash: auditLinkHash("c1", 2, rows[1]!.link.prev, e) } };
    const v = await verifyAuditLog(source(rows, checkpoints), keys);
    expect(v.problems.map((p) => [p.kind, p.seq])).toContainEqual(["broken-link", 3]);
  });

  it("detects a removed row in the middle", async () => {
    const { rows, checkpoints } = await written(5);
    rows.splice(2, 1);
    const v = await verifyAuditLog(source(rows, checkpoints), keys);
    expect(v.problems.map((p) => p.kind)).toContain("missing");
  });

  it("detects rows removed from the end once a checkpoint covers them", async () => {
    const { rows, checkpoints } = await written(5);
    rows.splice(3);
    const v = await verifyAuditLog(source(rows, checkpoints), keys);
    expect(v.problems.map((p) => p.kind)).toContain("truncated");
  });

  it("detects a whole chain removed, by its checkpoints", async () => {
    const { checkpoints } = await written(3);
    const v = await verifyAuditLog(source([], checkpoints), keys);
    expect(v.problems.map((p) => p.kind)).toEqual(["truncated"]);
  });

  it("reports rows after the last checkpoint as unanchored, not as a problem", async () => {
    const rows: ChainedAuditEvent[] = [];
    const checkpoints: AuditCheckpoint[] = [];
    const writer = new AuditChainWriter({ write: async (e) => void rows.push(...e), writeCheckpoint: async (c) => void checkpoints.push(c) }, { chain: "c1", key, everyRows: 3 });
    for (let i = 1; i <= 5; i++) await writer.append(event(i));
    const v = await verifyAuditLog(source(rows, checkpoints), keys);
    expect(v.ok).toBe(true);
    expect(v.chains[0]).toMatchObject({ anchoredThrough: 3, unanchored: 2 });
    await writer.close();
  });

  it("refuses a checkpoint signed by another key, or by none it knows", async () => {
    const { rows, checkpoints } = await written(3);
    const forged = signAuditCheckpoint({ chain: "c1", seq: 3, hash: rows[2]!.link.hash }, { keyId: "k1", privateKey: other.privateKey });
    const v = await verifyAuditLog(source(rows, [forged]), keys);
    expect(v.problems.map((p) => p.kind)).toEqual(["bad-signature"]);
    const unknown = await verifyAuditLog(source(rows, checkpoints), {});
    // The opening checkpoint and the head's: both name a key the verifier was not given.
    expect(unknown.problems.map((p) => p.kind)).toEqual(["unknown-key", "unknown-key"]);
  });

  it("refuses a checkpoint whose row was replaced", async () => {
    const { rows, checkpoints } = await written(3);
    const e = { ...rows[2]!.event, subjectId: "someone-else" };
    rows[2] = { event: e, link: { ...rows[2]!.link, hash: auditLinkHash("c1", 3, rows[2]!.link.prev, e) } };
    const v = await verifyAuditLog(source(rows, checkpoints), keys);
    expect(v.problems.map((p) => p.kind)).toContain("checkpoint-mismatch");
  });

  it("accepts a chain pruned behind a checkpoint, and refuses one pruned without", async () => {
    const { rows, checkpoints } = await written(9, { everyRows: 3 });
    const pruned = rows.slice(3);
    expect((await verifyAuditLog(source(pruned, checkpoints), keys)).ok).toBe(true);
    // Starting at the checkpointed row itself verifies too: its checkpoint signs it.
    expect((await verifyAuditLog(source(rows.slice(2), checkpoints), keys)).ok).toBe(true);
    const unanchoredPrune = rows.slice(4);
    const v = await verifyAuditLog(source(unanchoredPrune, checkpoints), keys);
    expect(v.problems.map((p) => p.kind)).toContain("missing-start");
  });

  it("hashes the stored form: a timestamp written with an offset verifies once read back", async () => {
    const e = event(1, { timestamp: "2026-11-03T10:00:00+01:00" });
    const log = new InMemoryAuditLog({ chain: "c1", key });
    await log.appendAuditEvent(e);
    await log.close();
    const v = await verifyAuditLog(log, keys);
    expect(v.ok).toBe(true);
    expect((await log.readChain("c1"))[0]!.event.timestamp).toBe("2026-11-03T09:00:00.000Z");
  });

  it("withAuditLog sends audit to the log and the model to the store", async () => {
    const model = new InMemoryRegistryStore();
    const log = new InMemoryAuditLog();
    const store = withAuditLog(model, log);
    await store.appendAuditEvent(event(1));
    expect((await model.listAuditEvents()).items).toEqual([]);
    expect((await store.listAuditEvents()).items.map((e) => e.id)).toEqual(["evt-1"]);
    await store.close?.();
    await expect(log.appendAuditEvent(event(2))).rejects.toThrow("closed");
  });

  it("a witness catches a chain deleted whole, rows cut from its end, or a row replaced (ADR-0124)", async () => {
    const { rows, checkpoints } = await written(12, { everyRows: 5 });
    const first = await verifyAuditLog(source(rows, checkpoints), keys);
    expect(first.ok).toBe(true);
    const witness = parseAuditWitness(JSON.parse(JSON.stringify(first.witness)));
    expect(witness.chains.c1).toMatchObject({ checkpoint: { seq: 12 }, head: { seq: 12 } });
    // Untouched, and with more rows since: still passes.
    expect((await verifyAuditLog(source(rows, checkpoints), keys, { witness })).ok).toBe(true);

    // Without the witness, a chain gone with its checkpoints leaves nothing to compare.
    expect((await verifyAuditLog(source([], []), keys)).ok).toBe(true);
    const gone = await verifyAuditLog(source([], []), keys, { witness });
    expect(gone.ok).toBe(false);
    expect(gone.problems.map((p) => p.kind)).toContain("vanished");
    expect(gone.problems[0]!.message).toContain("with every row of the chain");

    // The last rows cut off, and the checkpoint over them with them.
    const cut = await verifyAuditLog(source(rows.slice(0, 10), checkpoints.filter((c) => c.seq <= 10)), keys, { witness });
    expect(cut.problems.filter((p) => p.kind === "vanished").map((p) => p.seq)).toEqual([12, 12]);
    const headOnly = { ...witness, chains: { c1: { head: witness.chains.c1!.head! } } };
    const short = await verifyAuditLog(source(rows.slice(0, 10), checkpoints.filter((c) => c.seq <= 10)), keys, { witness: headOnly });
    expect(short.problems.find((p) => p.kind === "vanished")?.message).toBe("an earlier verification saw rows through 12, but the chain ends at 10");

    // The row the witness saw at its head is not the row there now.
    const swapped = await verifyAuditLog(source(rows, checkpoints), keys, { witness: { ...witness, chains: { c1: { head: { seq: 12, hash: "0".repeat(64) } } } } });
    expect(swapped.problems.some((p) => p.kind === "vanished" && p.message.includes("not the row"))).toBe(true);
  });

  it("refuses a witness that is not one", () => {
    expect(() => parseAuditWitness({ format: "other" })).toThrow(/typesys\.audit-witness\/1/);
    expect(() => parseAuditWitness({ format: "typesys.audit-witness/1", at: "x", chains: { c: { head: { seq: "1", hash: "h" } } } })).toThrow();
  });

  it("refuses a key that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(() => new AuditChainWriter({ write: async () => undefined, writeCheckpoint: async () => undefined }, { key: { keyId: "r", privateKey: rsa.privateKey } })).toThrow("Ed25519");
  });
});
