# 0066. Durable Execution on the Journal Seam: Postgres Now, Engines Behind It

## Status

Accepted (2026-10-14). Implemented in the new `@typesys/workflow-postgres`
(`PostgresWorkflowJournal`, `migrateWorkflowJournal`) and in
`@typesys/workflow` (`workflowJournalContract`, `WorkflowJournal.unfinished`,
sweeps that skip other services' runs). Proven by
`packages/workflow/test/journal-contract.test.ts` and
`packages/workflow-postgres/test/postgres-journal.test.ts`, which runs the
same contract against real Postgres, plus a crash after a non-idempotent
Action recovered by two processes at once and an approval deadline expired
by a process other than the one that set it.

## Context

ADR-0057 put durability behind `WorkflowJournal` and shipped only an
in-memory journal, deferring "a Postgres journal, or a Temporal or DBOS
binding". Mature durable-execution systems exist and the owner asked for
them to be used where appropriate rather than growing an orchestrator:

- **Temporal** runs a separate service (a cluster with its own
  persistence) and executes workflow code deterministically in a sandbox,
  replaying history to rebuild state
  ([Temporal TypeScript docs](https://docs.temporal.io/develop/typescript/workflows/basics)).
- **DBOS Transact** is a library that checkpoints workflow steps to
  Postgres ([DBOS Transact](https://github.com/dbos-inc/dbos-transact),
  [v2 for TypeScript](https://dbos.dev/blog/dbos-transact-v2-typescript)).

TypeSys's engine is already a deterministic interpreter over an
append-only event log; ADR-0065 made timers and authority journal events
too. What it lacked was a journal that survives the process.

## Decision

1. **Ship a Postgres journal.** `PostgresWorkflowJournal` keeps one row
   per run (length, finished flag, partial index on unfinished runs) and
   one JSONB row per event, append-only by trigger. An append is one
   transaction that locks the run's row and writes only at the expected
   length; starting a run races on inserting that row. So the engine's
   existing guarantee (of two writers, exactly one writes) holds across
   processes and machines. Postgres is already TypeSys's durable store
   (registry, adapter, audit), works in disconnected and customer-managed
   deployments, and adds no new infrastructure to operate.
2. **One contract for every journal.** `workflowJournalContract` is the
   test every implementation must pass (ordering, conditional and atomic
   appends, concurrent writers and starters, listings, copies). The
   in-memory and Postgres journals pass it; a future binding must too.
3. **Sweeps leave other services' runs alone.** With a shared journal,
   `tick`, `resumeAll` and `approvalsFor` advance only runs of workflows
   registered in this engine; previously they threw on the first foreign
   run (found by the Postgres test).
4. **Temporal and DBOS stay behind the seam, not shipped.** The governed
   part of a run (which steps are authoritative, who carries the run, what
   was approved and by whom) must remain in TypeSys's journal, because it
   is evidence and is what `replay` and the authority checks read. A
   Temporal binding would run each `advance` as an activity, with the
   journal as its state and Temporal's timers calling `tick`; a DBOS
   binding would make `advance` a DBOS workflow over the same Postgres.
   Both are mechanical given the seam, and neither can be verified here
   (no Temporal service is available in this environment, and a DBOS
   binding over the same Postgres adds a second checkpoint store that
   would have to agree with the journal). Neither is claimed. A deployment
   that already runs Temporal should get the binding as its own package,
   tested against a real cluster.

## Consequences

- Runs, approvals, timers and authority suspensions now survive restarts
  with only Postgres; `tick()` on a schedule from every replica is safe.
- Events are stored as JSONB: object key order is not preserved and
  `undefined` members are dropped. The engine compares values with
  `canonical` and never relies on either.
- Not addressed: retention and archival of finished runs, encryption of
  journaled values at rest (protect the table as you protect the audit
  log, ADR-0057), a pushed notification when a timer is due (timers fire
  when `tick` is called), and the Temporal and DBOS bindings above.

## Amended after the independent review (2026-10-14)

The review ([`docs/reviews/m2-adversarial-review.md`](../reviews/m2-adversarial-review.md))
found three Low-severity gaps in the Postgres journal. All three are fixed
by `migrations/0002_journal_integrity.sql`, which `migrateWorkflowJournal`
now runs after `0001`, in order:

- `TRUNCATE` of either table is refused (L1).
- The runs table follows the events table (L2). A row starts empty and
  unfinished. Its length is always the number of its events. It becomes
  finished only once its events hold a `run-finished` event, and never goes
  back. It is never deleted or truncated. Before this, marking a run
  finished behind the journal's back dropped it from `unfinished()`, and its
  deadline never fired.
- An event holding U+0000, which JSONB cannot store, is kept as its JSON
  text under a key no event has, and read back as it was written (L3). The
  journal contract now covers this case, so every journal must pass it.

These are integrity checks against mistakes and against tampering by
anything short of the table's owner. They are not a defense against an
attacker who can replace the triggers.

## Amended after the 3.0 pressure test

Found by the [3.0 pressure test](../reviews/3-0-pressure-test.md). An event whose JSON holds `\u0000` or a lone UTF-16
surrogate, which Postgres `jsonb` refuses, is stored wrapped with its
`type` beside it, so such a run can still finish (J1, J2).
