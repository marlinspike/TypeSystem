import type { KeyManagement } from "./security-profile.js";

/**
 * A small, swappable cache seam (see ADR-0016) — the same pattern as
 * `Adapter`/`RegistryStore`/`PolicyEngine`: one interface, one in-memory
 * implementation built now, a distributed backend (Redis, etc.) a
 * documented-not-built extension point for later.
 */
export interface Cache {
  /**
   * Whether values held here are readable only by this process, or only
   * under keys it holds (ADR-0036). The runtime never puts encrypted or
   * marked data in a cache where this isn't `true`; wrap a shared cache in
   * `EncryptedCache` (`@typesys/encryption`) to make it confidential.
   */
  readonly confidential: boolean;
  /** Where this cache's encryption keys come from, if it encrypts (ADR-0046). A security profile requires `"managed"`. */
  readonly keyManagement?: KeyManagement;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** Per-process: confidential, since the plaintext is already in this process's memory while it serves the read. */
export class InMemoryCache implements Cache {
  readonly confidential = true;
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
  /** It stores nothing, so nothing leaves the process. */
  readonly confidential = true;
  async get<T>(): Promise<T | undefined> {
    return undefined;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async clear(): Promise<void> {}
}
