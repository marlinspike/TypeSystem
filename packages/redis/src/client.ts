/**
 * The handful of Redis commands this package uses, typed structurally so any
 * node-redis v5+ client (`createClient()`, with or without modules, or a
 * cluster/sentinel client exposing the same methods) fits without dragging
 * node-redis's generic client types through the public API.
 */
export interface RedisCommands {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { expiration: { type: "PX"; value: number } }): Promise<unknown>;
  del(keys: string | string[]): Promise<number>;
  scanIterator(options: { MATCH: string; COUNT?: number }): AsyncIterable<string[]>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

/** Escapes Redis glob metacharacters so a key prefix matches literally in `SCAN MATCH`. */
export function escapeGlob(literal: string): string {
  return literal.replace(/[*?[\]\\]/g, (c) => `\\${c}`);
}
