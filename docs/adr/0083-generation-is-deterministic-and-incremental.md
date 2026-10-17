# 0083. Generation Is Deterministic and Incremental, and Handwritten Code Is Never Overwritten

## Status

Accepted (2026-10-16). Builds on ADR-0079 to ADR-0082. Implemented in
`packages/compiler/src/compile.ts`. Proven by
`packages/compiler/test/compile.test.ts`.

## Context

An agent or a developer compiles an application many times: after every
change to `app.json`, after a model change, after a review. Each compile
must be safe to repeat and cheap to review. Three things go wrong with
naive generators: output that changes when nothing changed (timestamps,
map order), generated files edited by hand and silently overwritten, and
handwritten files regenerated over the developer's work.

## Decision

**`generate(analysis)` is a pure function** of the checked application.
It returns two maps: the files the compiler owns (`server.ts`,
`index.html`, everything under `src/generated/`) and the files it writes
once (`package.json`, `tsconfig.json`, `.gitignore`, each
`src/extensions/<module>.ts(x)` stub, and `src/extensions/server.ts` when
the application has an LLM configuration). Flows and pages are emitted in
name order, and no output carries a time, a path outside the application
or a random value. The graph layout in `@typesys/ui` follows the same
rule: its starting offsets are a hash of the node key, never
`Math.random`.

**Nothing is written unless the check passes.** A specification with any
error-severity diagnostic writes no file.

**Owned files are written only when their content changes**, and the
result lists `written` and `unchanged` separately, so a second compile of
an unchanged application writes nothing.

**A hand edit to an owned file stops the compile.** `typesys.lock.json`
records a SHA-256 of the canonical specification and of every owned file
as last written. A file whose content no longer has its hash is reported
as `edited-generated-file` at that path, with the hint to move the change
to `app.json` or `src/extensions/`; `force: true` overwrites it.

**Write-once files are the developer's.** A stub is written only when no
`.ts` or `.tsx` of that module exists, and never again.

**What a removed page or flow generated is removed**: an owned file listed
in the previous lock and not generated now is deleted, and reported in
`removed`.

## Consequences

Regeneration is reviewable: the diff of a compile is the diff of the
meaning, and the files a change touched are listed in the result. The
lock lets the compiler tell an agent exactly which generated file a
person edited instead of discarding the edit. Semantic diffs and impact
analysis between two versions of `app.json` build on the same pure
`generate` (ADR-0085).
