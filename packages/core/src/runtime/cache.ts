/**
 * A small, swappable cache seam (see ADR-0016) — the same pattern as
 * `Adapter`/`RegistryStore`/`PolicyEngine`: one interface, one in-memory
 * implementation built now, a distributed backend (Redis, etc.) a
 * documented-not-built extension point for later.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class InMemoryCache implements Cache {
  private readonly entries = new Map<string, Entry>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

/** Always misses, never stores — what every `SemanticRuntime` uses when no `Cache` is supplied, preserving pre-ADR-0016 "always live" behavior exactly. */
export class NoopCache implements Cache {
  async get<T>(): Promise<T | undefined> {
    return undefined;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async clear(): Promise<void> {}
}
