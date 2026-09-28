import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // Postgres-gated test files (adapter-postgres, registry-store-postgres)
    // share one real external database — running test *files* in parallel
    // (vitest's default) means one file's `TRUNCATE`/setup can race another
    // file's reads/writes against the same table, causing real, intermittent
    // cross-file failures. `isolate: false` reuses one worker across every
    // file instead of spawning one per file, which is what makes running
    // everything sequentially still fast (~1s, not ~7s) — safe here since no
    // test file relies on a fresh global/module registry per file.
    fileParallelism: false,
    isolate: false
  }
});
