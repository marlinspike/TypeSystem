import semver from "semver";

/**
 * Shared semver-range resolution for every `RegistryStore` implementation
 * (see ADR-0015) — kept in one place so the in-memory and Postgres backends
 * cannot silently drift into different versioning semantics.
 */
export function latestFirst<T extends { version: string }>(versions: T[]): T[] {
  return [...versions].sort((a, b) => semver.rcompare(a.version, b.version));
}

export function resolveVersion<T extends { version: string }>(versions: T[], versionRange?: string): T | undefined {
  const sorted = latestFirst(versions);
  if (sorted.length === 0) return undefined;
  if (!versionRange) return sorted[0];
  return sorted.find((v) => semver.satisfies(v.version, versionRange));
}
