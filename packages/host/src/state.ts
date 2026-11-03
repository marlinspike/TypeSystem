import { createPrivateKey } from "node:crypto";
import type { Pool } from "pg";
import { createClient } from "redis";
import {
  InMemoryAuditLog,
  InMemoryCache,
  InMemoryRateLimiter,
  type AuditChainSource,
  type AuditLogStore,
  type AuditSigningKey,
  type Cache,
  type RateLimiter
} from "@typesys/core";
import { PostgresAuditLog, createPool } from "@typesys/registry-store-postgres";
import { RedisCache, RedisRateLimiter, type RedisCommands } from "@typesys/redis";
import { InMemoryJournal, type WorkflowJournal } from "@typesys/workflow";
import { PostgresWorkflowJournal, migrateWorkflowJournal } from "@typesys/workflow-postgres";
import { DeploymentError, type AuditStateSpec, type Credential, type Deployment } from "./deployment.js";

/** Resolves a credential reference: what `host.ts` does for sources, shared here. */
export type ResolveCredential = (value: Credential, at: string) => string;

/** What the deployment's `state` resolves to (ADR-0106): live connections, opened once and closed with the host. */
export interface HostState {
  readonly audit: AuditLogStore & AuditChainSource & { readonly chain: string };
  readonly journal: WorkflowJournal;
  readonly cache?: Cache;
  readonly rateLimiter?: RateLimiter;
  /** Where each piece is kept, for `/version` and the upgrade check. */
  readonly kinds: { readonly audit: string; readonly workflows: string; readonly cache: string; readonly rateLimit: string };
  /** The Postgres pool for a connection string, opened once however many pieces share it. */
  readonly pool: (url: string) => Pool;
  close(): Promise<void>;
}

class MemoryAudit extends InMemoryAuditLog {
  get chain(): string {
    return this.writer.chain;
  }
}

class PostgresAudit extends PostgresAuditLog {
  get chain(): string {
    return this.writer.chain;
  }
}

/** The signing key a deployment's audit names, resolved and checked, or none. */
export function auditSigningKey(spec: AuditStateSpec | undefined, resolve: ResolveCredential): AuditSigningKey | undefined {
  if (!spec?.signing) return undefined;
  const pem = resolve(spec.signing.key, "state.audit.signing.key");
  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new DeploymentError(["state.audit.signing.key: is not a PEM private key"]);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new DeploymentError(["state.audit.signing.key: must be an Ed25519 key"]);
  return { keyId: spec.signing.keyId, privateKey };
}

/**
 * Opens what the deployment's `state` declares. Every connection is made
 * before the host starts serving, so a database or Redis that cannot be
 * reached is a boot failure, not a first request that fails.
 */
export async function openState(deployment: Deployment, resolve: ResolveCredential): Promise<HostState> {
  const state = deployment.state ?? {};
  const pools = new Map<string, Pool>();
  const redis = new Map<string, ReturnType<typeof createClient>>();
  const pool = (url: string) => {
    let p = pools.get(url);
    if (!p) {
      p = createPool({ connectionString: url });
      pools.set(url, p);
    }
    return p;
  };
  const redisClient = async (url: string, at: string): Promise<RedisCommands> => {
    let c = redis.get(url);
    if (!c) {
      c = createClient({ url });
      c.on("error", () => undefined);
      redis.set(url, c);
      try {
        await c.connect();
      } catch (err) {
        throw new DeploymentError([`${at}: cannot reach Redis (${(err as Error).message})`]);
      }
    }
    return c;
  };
  const closeAll = async () => {
    await Promise.allSettled(
      [...redis.values()].map(async (c) => {
        if (c.isOpen) await c.close();
      })
    );
    await Promise.allSettled([...pools.values()].map((p) => p.end()));
  };

  try {
    const a = state.audit ?? { kind: "memory" as const };
    const key = auditSigningKey(a, resolve);
    const writer = {
      ...(key ? { key } : {}),
      ...(a.signing?.everyRows !== undefined ? { everyRows: a.signing.everyRows } : {}),
      ...(a.signing?.everySeconds !== undefined ? { everyMs: a.signing.everySeconds * 1000 } : {})
    };
    let audit: HostState["audit"];
    if (a.kind === "postgres") {
      const p = pool(resolve(a.url, "state.audit.url"));
      await reachable(p, "state.audit");
      await migrated(p);
      audit = new PostgresAudit(p, writer);
    } else audit = new MemoryAudit(writer);

    const w = state.workflows ?? { kind: "memory" as const };
    let journal: WorkflowJournal;
    if (w.kind === "postgres") {
      const p = pool(resolve(w.url, "state.workflows.url"));
      await reachable(p, "state.workflows");
      // Idempotent and serialized by an advisory lock (ADR-0066): every replica may run it at start.
      await migrateWorkflowJournal(p);
      journal = new PostgresWorkflowJournal(p);
    } else journal = new InMemoryJournal();

    const c = state.cache;
    let cache: Cache | undefined;
    if (c?.kind === "redis") cache = new RedisCache(await redisClient(resolve(c.url, "state.cache.url"), "state.cache"), { ...(c.keyPrefix ? { keyPrefix: c.keyPrefix } : {}) });
    else if (c?.kind === "memory") cache = new InMemoryCache();

    const r = state.rateLimit;
    let rateLimiter: RateLimiter | undefined;
    if (r?.kind === "redis")
      rateLimiter = new RedisRateLimiter(await redisClient(resolve(r.url!, "state.rateLimit.url"), "state.rateLimit"), {
        capacity: r.capacity,
        refillPerSecond: r.refillPerSecond,
        ...(r.keyPrefix ? { keyPrefix: r.keyPrefix } : {})
      });
    else if (r?.kind === "memory") rateLimiter = new InMemoryRateLimiter({ capacity: r.capacity, refillPerSecond: r.refillPerSecond });

    let closed = false;
    return {
      audit,
      journal,
      ...(cache ? { cache } : {}),
      ...(rateLimiter ? { rateLimiter } : {}),
      kinds: { audit: a.kind, workflows: w.kind, cache: c?.kind ?? "none", rateLimit: r?.kind ?? "none" },
      pool,
      async close() {
        if (closed) return;
        closed = true;
        // The audit log first: it writes what is pending and signs its last checkpoint over the pool it shares.
        await audit.close?.().catch(() => undefined);
        await closeAll();
      }
    };
  } catch (err) {
    await closeAll();
    throw err;
  }
}

async function reachable(pool: Pool, at: string): Promise<void> {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    throw new DeploymentError([`${at}: cannot reach Postgres (${(err as Error).message})`]);
  }
}

/** The audit tables must be migrated through ADR-0105's chain columns; the host never migrates them itself (ADR-0015). */
async function migrated(pool: Pool): Promise<void> {
  try {
    await pool.query("SELECT chain, seq, prev_hash, hash FROM audit_events LIMIT 0");
    await pool.query("SELECT chain FROM audit_checkpoints LIMIT 0");
  } catch {
    throw new DeploymentError(["state.audit: the audit tables are not migrated for chaining: run `npm run migrate:postgres` (migration 0008) first"]);
  }
}
