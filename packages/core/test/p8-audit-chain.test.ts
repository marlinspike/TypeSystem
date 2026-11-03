import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUDIT_GENESIS, AuditChainWriter, InMemoryAuditLog, auditLinkHash, verifyAuditLog, type AuditEvent, type ChainedAuditEvent } from "../src/index.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = { k1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const key = { keyId: "k1", privateKey };

const ev = (id: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  id,
  timestamp: new Date(Date.UTC(2026, 10, 1)).toISOString(),
  subjectId: "u1",
  action: "read",
  resource: { typeName: "T" },
  decision: "allow",
  ...extra
});

describe("P8 audit chain writer", () => {
  it("P8-M1: an event that cannot be normalized settles every append batched with it (no hang, no unhandled rejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const log = new InMemoryAuditLog();
      // Occupy the writer so the next appends are batched together.
      const first = log.appendAuditEvent(ev("a"));
      const good = log.appendAuditEvent(ev("b"));
      const bad = log.appendAuditEvent(ev("c", { details: { n: 10n as unknown as number } }));
      await first;
      const settled = await Promise.race([
        Promise.allSettled([good, bad]).then((r) => r.map((x) => x.status)),
        new Promise((r) => setTimeout(() => r("hung"), 300))
      ]);
      await new Promise((r) => setTimeout(r, 20));
      expect({ settled, unhandled: unhandled.length }).toEqual({ settled: ["fulfilled", "rejected"], unhandled: 0 });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("P8-M2: a write that committed but reported failure (lost COMMIT ack) does not wedge the chain forever", async () => {
    const stored = new Map<string, ChainedAuditEvent>();
    let failNextAfterWrite = true;
    const writer = new AuditChainWriter({
      async write(entries) {
        for (const e of entries) if (stored.has(`${e.link.chain}:${e.link.seq}`)) throw new Error(`duplicate key (chain, seq)=(${e.link.chain}, ${e.link.seq})`);
        for (const e of entries) stored.set(`${e.link.chain}:${e.link.seq}`, e);
        if (failNextAfterWrite) {
          failNextAfterWrite = false;
          throw new Error("Connection terminated unexpectedly");
        }
      },
      async writeCheckpoint() {}
    });
    await writer.append(ev("x1")).catch(() => undefined);
    // Every later append fails: the writer retries seq 1, which is already stored.
    const later = await Promise.allSettled([writer.append(ev("x2")), writer.append(ev("x3"))]);
    expect(later.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});

describe("P8 verifyAuditLog", () => {
  it("P8-M3: a whole fabricated chain with no checkpoint verifies ok in a signed trail", async () => {
    const log = new InMemoryAuditLog({ key, chain: "real" });
    await log.appendAuditEvent(ev("r1"));
    await log.close();
    // Anyone with INSERT on audit_events can compute the hashes: no secret is involved.
    const forged: ChainedAuditEvent[] = [];
    let prev = AUDIT_GENESIS;
    for (let i = 1; i <= 3; i++) {
      const e = ev(`forged-${i}`, { subjectId: "alice", action: "approve", decision: "allow" });
      const hash = auditLinkHash("forged", i, prev, e);
      forged.push({ event: e, link: { chain: "forged", seq: i, prev, hash } });
      prev = hash;
    }
    const source = {
      listChains: async () => [...(await log.listChains()), "forged"],
      readChain: async (c: string, o?: { afterSeq?: number; limit?: number }) => (c === "forged" ? forged.filter((r) => r.link.seq > (o?.afterSeq ?? 0)) : log.readChain(c, o)),
      listCheckpoints: (c?: string) => log.listCheckpoints(c),
      countUnchained: async () => 0
    };
    const v = await verifyAuditLog(source, keys);
    // The forged chain is only a summary line ("3 unanchored"); the verdict is OK and `audit verify` exits 0.
    expect(v.ok).toBe(false);
  });
});
