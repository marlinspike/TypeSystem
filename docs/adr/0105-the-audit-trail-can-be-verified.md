# 0105. The Audit Trail Can Be Verified

## Status

Accepted (2026-11-03). Closes `docs/PRODUCTION-READINESS.md` item 9's
tamper-evidence, export and retention gaps. Implemented in
`packages/core/src/audit/chain.ts`, `packages/registry-store-postgres`
(`postgres-audit-log.ts`, migration 0008) and `packages/host/src/audit-cli.ts`
(`typesys audit verify|export|prune|keygen`). Proven by
`packages/core/test/audit-chain.test.ts`,
`packages/registry-store-postgres/test/audit-chain.test.ts`,
`packages/host/test/audit-cli.test.ts` and `npm run audit:demo`.

## Context

Since ADR-0015 the audit log has been append-only by trigger. A trigger
stops an application bug, not the table's owner: anyone who can disable it
can edit, delete or reorder rows, and nothing afterwards would show it.
There was no export and no retention.

## Decision

Every row a process appends carries its writer's chain id, a sequence
number, the hash of the row before it and its own hash: SHA-256 over the
canonical form of the row, its link included. Each process writes its own
chain, so replicas take no lock in common; appends made while a write is in
flight are batched into one INSERT, and a batch that fails is retried row by
row, so one row that cannot be written fails only its own append and never
leaves a gap. What is hashed is the stored form (millisecond ISO
timestamps, JSON as it round-trips, U+0000 and lone surrogates replaced in
keys and values, null optional fields dropped), so a row read back hashes as
it was written. A write can commit and still report failure; the writer
then asks the store for the chain's stored head and resumes from it, and if
the store cannot say, it starts a new chain rather than guess.

A writer given an Ed25519 key signs its chain's head every N rows, at least
every T seconds while it writes, and when it closes (the generic server
closes on SIGTERM), and signs an opening checkpoint (sequence 0, the
genesis hash) before its chain's first row. Checkpoints live in their own
append-only table. The row hashes use no secret, so anyone who may insert
rows can compute them; the opening checkpoint is what tells a chain a
signing writer started from one inserted by someone else, which verify
reports as `unsigned-chain` in a trail with verify keys.

`verifyAuditLog` walks every chain from its start and reports a row whose
content no longer hashes to its hash (`altered`), a row that does not link
to the one before (`broken-link`), a gap (`missing`), a checkpoint that
names a row past the chain's end (`truncated`), a checkpoint that does not
match its row, and a signature that does not verify or names an unknown
key. Rows after the last checkpoint are reported as unanchored: their
removal from the tail would not be detectable, which is what the signing
interval bounds.

Retention deletes, per chain, the rows before the latest checkpointed row
older than the cutoff, and keeps that row: its checkpoint signs it, so the
chain still verifies from there, and a chain pruned whole is still told from
one deleted. The DELETE trigger allows only that: a session that sets
`typesys.audit_prune`, a chained row, a checkpoint covering it. The prune is
itself audited, before it deletes and again with what it deleted.

## Consequences

Editing a viewer's refusal into an allow, with the trigger lifted by the
table's owner, is reported by `typesys audit verify` as the row and chain
(`npm run audit:demo`). An export (`typesys audit export`) verifies offline.
Rows written before migration 0008 are counted as unchained and are not
covered. The trigger is still not what makes the trail trustworthy, and
anyone who holds the signing key can forge checkpoints: keep it in a
secret store the database's owner cannot read. Deleting a whole chain that
was never checkpointed is not detectable.
