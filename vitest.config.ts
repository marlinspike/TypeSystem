import { defineConfig } from "vitest/config";

const INCLUDE = ["packages/*/test/**/*.test.ts", "tools/*/test/**/*.test.ts"];
// Starts the whole showcase from the two example applications' dist/
// folders, which the cold chain and recall response tests delete and
// rebuild in place. It runs in a group of its own, after every other file.
const SHOWCASE = ["packages/showcase/test/launch.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    // Postgres-gated test files (adapter-postgres, registry-store-postgres)
    // share one real external database — running test *files* in parallel
    // (vitest's default) means one file's `TRUNCATE`/setup can race another
    // file's reads/writes against the same table, causing real, intermittent
    // cross-file failures. `isolate: false` reuses one worker across every
    // file instead of spawning one per file, which is what makes running
    // everything sequentially still fast (~1s, not ~7s) — safe here since no
    // test file relies on a fresh global/module registry per file.
    // Without those databases (a pull request's CI, or `npm test` with nothing
    // configured) nothing is shared, so files run in parallel.
    fileParallelism: process.env.DATABASE_URL === undefined && process.env.REDIS_URL === undefined,
    // In parallel on a shared runner a test that takes 3s alone can take more than vitest's default 5s.
    testTimeout: 30_000,
    isolate: false,
    projects: [
      { extends: true, test: { name: "packages", include: INCLUDE, exclude: SHOWCASE, sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "showcase", include: SHOWCASE, sequence: { groupOrder: 1 } } }
    ]
  }
});
