#!/usr/bin/env node
// Committed, not built, so that npm links the `typesys-host` command when it installs
// a fresh clone, before `npm run build` has produced dist/ (npm links a bin only
// if its file exists at install time).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = new URL("../dist/serve.js", import.meta.url);
if (!existsSync(fileURLToPath(target))) {
  console.error("typesys-host: this package is not built yet. Run `npm run build` at the repository root, then try again.");
  process.exit(1);
}
const loaded = await import(target.href);
if (typeof loaded.main === "function") await loaded.main();
