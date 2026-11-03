# Mandate 8 pressure test (durable state, verifiable audit, exact policy comparison)

Reviewed: `claude/project-thread-j6ghrz` at dd6ba14 (ADR-0105 to ADR-0109),
2026-11-03. An independent reviewer worked in a separate worktree against
real PostgreSQL and Redis and tried to break the chained audit trail, the
deployment `state` section, hosted applications, `typesys audit` and the
exact policy comparison in `typesys deploy check`. Every finding below was
reproduced with a test that failed before it was reported. The reproduction
tests are kept beside the suites they belong to (`packages/*/test/p8-*.test.ts`)
and all pass now.

**Summary: 11 findings, no High. 6 Medium, 5 Low.** All 11 are fixed. Of the
reviewer's seven lower-confidence notes, five are fixed and two are kept as
documented limits. 19 new mutations guard the audit chain, the state checks
and the exact comparison.

The common thread was what an auditor of the auditor would ask: is a failure
in the trail itself handled as carefully as the decisions it records? A batch
that could hang, a write whose outcome was unknown, and a chain nobody signed
were each places where the trail could stop or vouch for rows it should not.

## Medium

### M1. An event that could not be hashed hung its whole batch. Fixed.

The writer linked each pending event outside its error handling. An event
whose details JSON cannot encode (a BigInt, a cycle) made the flush throw, so
every append batched with it never settled, and the rejected flush was an
unhandled rejection, which stops a Node process. Each event is now linked on
its own; one that cannot be hashed rejects only its own append, and the flush
can no longer reject unobserved (`packages/core/src/audit/chain.ts`).

### M2. A write that committed but reported failure wedged the chain. Fixed.

If the COMMIT succeeded and its acknowledgement was lost, the writer kept its
head where it was and retried the same sequence numbers, which the unique
index then refused forever. After any failed write the writer now asks the
store for the chain's stored head (`headOf`, a new optional sink method the
Postgres log implements). If the failed batch is in fact the stored head, it
counts as written; if the head did not move, the chain carries on; if the
store cannot say, the writer signs what it knows was written and starts a new
chain, so the old one simply ends and still verifies.

### M3. A fabricated chain passed `audit verify` in a signed trail. Fixed.

The row hashes use no secret, so anyone who may insert into `audit_events`
could add a whole chain of invented rows, which verify reported only as
"unanchored". A signing writer now signs an opening checkpoint (sequence 0,
the genesis hash) before a chain's first row, and in a trail with verify keys a
chain with no checkpoint at all is a problem, `unsigned-chain`. The tail of a
live chain after its last checkpoint is still unanchored by design (at most
`everyRows` rows or `everySeconds`); verify reports it in the summary.

### M4. A null field became a false tamper alarm after a Postgres round trip. Fixed.

An event with `reason: null`, `details: null` or `objectId: null` was hashed
with the null, stored as SQL NULL and read back absent, so it was reported
`altered`. Normalization now drops null optional fields before hashing, so
null and absent hash the same in memory and in Postgres.

### M5. The exact comparison missed widenings through an attribute named `__proto__`. Fixed.

Witness requests were built by assignment, which sets the prototype for the
key `__proto__` instead of an own property. The constructed request failed the
new rule and the conjunction was silently skipped, so a real widening read as
none. Attributes are now defined as own properties, and a constructed request
that does not satisfy its own rule raises `PolicyNotComparableError` instead of
being skipped; `deploy check` blocks such a change as unverified.

### M6. Widening `runtime.inspectionPolicy` did not block. Fixed.

The rule that decides who may inspect the enforcement structure and explain
another subject's access decides no Type, property or Action, so both the
persona and the exact path dropped it. It now counts as a slot the rule
decides, and an exact widening of it blocks.

## Low

### L1. A details key containing U+0000 made a row unwritable. Fixed.

Normalization rewrote only values. Keys are now scrubbed the same way, so no
store refuses the row.

### L2. A signing key that did not match its verify key booted. Fixed.

Every checkpoint it wrote would fail verification, and nobody would learn it
until a later `audit verify`. The host now compares the private key's public
half with `state.audit.verifyKeys[keyId]` at boot and refuses a mismatch.

### L3. A failed boot left the state open. Fixed.

An extension's `adapters()` throwing, or anything later in the build, left
Redis clients, Postgres pools and the checkpoint timer open. Everything after
the state opens is now in one block that closes it on any failure.

### L4. Other state and security downgrades did not block. Fixed in part.

`deploy check` now also blocks losing a rate limit, a Redis rate limit made
per-process (each replica would admit the whole budget), dropping
`runtime.securityProfile`, and removing or replacing an audit verify key
(checkpoints it signed would become `unknown-key`; rotate by adding a key).
Kept: changing `state.audit.url` to another reference is listed under the
changed settings but does not block, because a reference names a secret, not
a database, and moving the trail is a legitimate migration.

### L5. An explanation could cover unbounded work on one charge. Fixed.

`runtime.explaining` charged its investigator once, then replayed any number
of operations uncharged, and nothing stopped an Action inside it. It now
charges the investigator once more for every 100 operations it replays, and
`invokeAction` refuses to run inside an explanation.

## The reviewer's other notes

Fixed: `state.cache.ttlMs` was validated but ignored (it is now the runtime's
default time to live); the Redis cache and rate-limit key prefixes defaulted to
names two deployments sharing one Redis would collide on (they now default to
the deployment's name); a pre-inserted checkpoint row silently replaced the
real one (a conflicting checkpoint is now an error); a prune committed its
deletion before writing its own audit row (it now records itself before it
deletes, and again with what it deleted); shutdown could wait forever on open
MCP and SSE streams, and so never sign its last checkpoint (it now ends them);
a hosted application that exported no contract skipped the contract check (it
is now refused).

Kept as documented limits: the database's delete guard trusts any checkpoint
row, signed or not, because a trigger cannot check a signature; someone who
can insert checkpoint rows could let a prune delete rows a real checkpoint
does not cover, which verify then reports. And hosted applications share one
workflow engine and model map, so one application's port serves every hosted
application's flows; each is still governed by the caller's own access.

## Verified sound by the reviewer

Editing a row, moving it to another chain or changing its sequence number;
inserting or removing rows inside the signed range; deleting a signed tail or
a whole signed chain; forging, re-keying or replaying a checkpoint; the
append-only triggers; timestamp, key-order and number round trips through
Postgres; the batch fallback leaving no gaps; the normal-form reasoning of
the exact comparison; `deploy check` writing nothing; and the loading rules
for hosted application modules.
