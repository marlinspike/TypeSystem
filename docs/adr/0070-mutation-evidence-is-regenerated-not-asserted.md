# 0070. Mutation Evidence Is Regenerated, Not Asserted

## Status

Accepted (2026-10-14). Implemented in `tools/mutation/` (the catalog,
`catalog.json`, and its rules, `mutation.ts`), `scripts/mutation.ts`
(`npm run mutation`). The committed
record is `docs/evidence/mutation/latest.json`. Proven by
`tools/mutation/test/mutation.test.ts`, which also checks that every
catalogued mutation still applies to exactly the code it names.

## Context

Earlier ADRs say "mutation-checked: N mutations, each failing at least one
test" (ADR-0052, 0059, 0063 and others). Those numbers came from mutations
applied by hand in a session and then discarded: nobody can rerun them,
nothing says which revision they ran on, and the 2026-10-14 pressure test
could not reproduce the counts. A claim no one can regenerate is not
evidence, and for a security mechanism, tests that only confirm the
expected path say little about whether they would notice it breaking.

## Decision

**A committed catalog.** Each mutation is an exact text replacement in one
file (`find`, `replace`, and `occurrence` when the text repeats), the ADR
whose guarantee it breaks, what it breaks in words, and the test files that
must catch it. Exact text, not a line number or an AST pattern, so a
mutation applies to the same code every time and goes *stale*, failing the
run, when that code changes, rather than silently mutating something else.
A mutation whose tests need infrastructure says so (`requires:
["DATABASE_URL"]`) and is reported `not-run` without it. A mutation that
cannot change behavior may be marked `equivalent` with a reason; nothing
else may survive.

**A harness that proves its own preconditions.** `npm run mutation`
refuses a dirty tree (unless `--allow-dirty`, which is recorded), checks
that the unmutated tree builds and every named test passes, then for each
mutation: applies it, forces a full rebuild (`tsc -b --force` of the root
project and the mutated file's own package), runs the named tests, and
restores the file, also on an error or a signal. A mutation the compiler
rejects is `killed-by-compiler`, reported apart from `killed` because it
shows the type system caught it, not a test.

**An evidence record.** Each run writes the git revision and branch,
whether the tree was clean, the command, Node, OS, CPU, TypeScript and
Vitest versions, whether `DATABASE_URL` was set, the catalog's SHA-256 and
size, and each mutation's status, duration and up to five failing test
names. The run exits 1 on a survivor, a stale entry or an unrun mutation
(`--allow-not-run` relaxes the last for a machine without Postgres).

**Regenerated locally.** The committed `latest.json` is one run of `npm
run mutation`, made on the revision it names; regenerating it is the
same command on that revision, with Postgres for the mutations that need
it. The catalog is never run on GitHub for a change (amended 2026-10-17: a
full run takes over half an hour of Actions time); the Mutation workflow
remains, to be started by hand only. A change to guarded code runs
the mutations that guard it locally before it is pushed (`--only`).

**What the first catalog covers.** 45 mutations: every mechanism of M2
(continuing authority, durable timers, the journals, the release boundary,
discovery, pack revocation), the read path's post-read check, the product
name check, and each high-severity pressure-test finding (workflow review
bypass through read steps and self-approval, computed values reading
undeclared inputs, packs overwriting registered Types, upgrades that
weaken protections, subtypes replacing inherited policies). Writing it
found three mechanisms no test exercised (a cancel by someone other than
the initiator with no cancel policy, engines sharing a journal sweeping
each other's runs, a pack redefining a registered Type when another
conflict also refused it) and four mutations that only failed to compile;
tests were added and the mutations rewritten until each was killed by a
test.

## Consequences

- A mutation count in an ADR or the README is a pointer to a record
  someone can regenerate, with the revision it ran on.
- The catalog is maintained like tests: a refactor that moves guarded code
  makes the run fail as stale until the catalog follows it.
- Earlier ADRs' hand-run counts stay as written, as history; they are not
  covered by the catalog unless a mutation for them is added.
- Not addressed: generated mutations (operators flipped across a whole
  file, as Stryker does), which would find gaps the catalog's authors did
  not think of; the catalog checks the mechanisms its authors named.

## Amended after the 3.0 pressure test's addendum

Found by the [3.0 pressure test](../reviews/3-0-pressure-test.md). The runner runs as `node --import tsx` and never blocks its
event loop, so Ctrl-C or SIGTERM reaches its handler: it stops the running
build or test, restores every mutated file and force-rebuilds them before it
exits (P3-M1). Only a reported test or test-file failure kills a mutation; a
run stopped by a signal or the 20-minute step limit, or exiting non-zero with
nothing failed, is `inconclusive` and fails the run (P3-M4). The mutation job
runs on every pull request, since a change to guarded code or to the tests
that kill its mutations matters as much as a change to the catalog (P3-M5).
The catalog now covers the workflow engine's own decisions: fail-closed on a
throwing engine or a non-boolean `allow`, and the audience half (P3-M2, M3).
