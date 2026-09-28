#!/usr/bin/env node
import { createPool } from "./pool.js";
import { runMigrations } from "./migrate.js";

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const result = await runMigrations(pool);
    console.log(`Applied ${result.applied.length} migration(s): ${result.applied.join(", ") || "(none pending)"}`);
    console.log(`Already applied: ${result.alreadyApplied.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
