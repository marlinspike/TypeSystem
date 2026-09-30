# 0035. Record-Bound Encryption Envelopes (`tsenc2`)

## Status

Accepted — implemented in `@typesys/encryption` (`tsenc2` in `src/cipher.ts`,
with HKDF labels fixed across envelope versions; `seal(type, id, values)`,
`reseal`, `ActionWrite`, and `legacyUnboundEnvelopes` in
`src/encrypting-adapter.ts`). Proven by:

- `packages/encryption/test/record-binding.test.ts` — seal writes `tsenc2`
  and refuses an unnamed record; an **attack** block moving one field to
  another record, copying a whole record under another id, reading under an
  id differing only in case or whitespace, and trying contexts that collide
  under a delimiter but not under the JSON encoding — all refused; legacy
  `tsenc1` refused by default, a downgrade to another record's unbound
  ciphertext refused by default and (pinned) accepted while legacy reads are
  on; `reseal` migrating to `tsenc2` with indexes intact, re-encrypting under
  a rotated key, and refusing to launder a ciphertext bound to another
  record; Actions refused without an id when they carry encrypted fields,
  passing through without one when they don't, and sealing under the id they
  name; malformed config refused.
- `packages/encryption/test/encrypting-adapter.test.ts` — the ADR-0033
  residual test now asserts a same-field swap *is* detected; a write through
  the runtime is bound to the record its input names; the mock REST work
  order (adapter-assigned id) is refused before the adapter runs, and given a
  caller id it ignores, fails loudly on its result.
- `packages/encryption/test/postgres.test.ts` — a ciphertext moved between
  rows with SQL fails closed; run against a local PostgreSQL 17.

Mutation-checked: dropping the record from the AAD, accepting `tsenc1` by
default, allowing an Action without an id, unsealing a result under the
input's id, a `reseal` that can't read legacy envelopes, `seal` without a
record, or a cipher that ignores the legacy flag each fails the suite.

## Context

ADR-0033's envelope, `tsenc1`, authenticates a ciphertext against its Type,
field, and key id, but not its record. Someone with write access to the
store can move a ciphertext between two records of the same Type and field
— give one patient another's date of birth, or another's diagnosis — and
every read succeeds. ADR-0033 pinned this with a test asserting the swap is
*not* detected and listed it for human review; review classed it a
production blocker.

The reason it was left open is real: binding needs the object's id at the
moment of encryption, and a create often doesn't have one yet — the adapter
assigns it. That constraint doesn't go away; it has to be designed around.
And it has to be decided now: the envelope is a persisted format, and every
record written before the decision is a migration afterwards.

## Decision

**1. A new envelope, `tsenc2`, bound to the object id.**
`tsenc2.<keyId>.<iv>.<ciphertext+tag>`, with additional authenticated data
`["tsenc2", typeName, field, keyId, objectId]` (a JSON array, so no id or
field name can make two contexts collide). A ciphertext moved to another
record, another field, or another Type — or read under a different key id —
fails authentication. The blind index stays value-only (a lookup has no id
to bind to) and remains verified against the decrypted value on every read.

**2. Every write names the record.** `seal(typeName, objectId, values)`
takes the id; an empty or non-string id is refused. For Actions, the config
maps each one to the Type it writes *and the input field carrying the
record's id*:

```ts
actions: { RegisterPatient: { type: "hospital.Patient", idField: "id" }, Ping: null }
```

An Action whose input carries an encrypted field but no id in that field is
refused before the adapter runs (`EncryptedFieldError`). The input is sealed
under the input's id; the result is unsealed under the result's own
`idField` — so an adapter that ignored the caller's id and assigned another
produces a result that fails to decrypt, loudly, rather than a record
silently bound to the wrong id.

**3. Adapter-assigned ids and encrypted fields don't mix.** A create whose
id only exists after the adapter runs cannot be bound, and this ADR does not
pretend otherwise: such an Action must supply the id itself (client-generated
ids, e.g. ULIDs, for encrypted Types — the pattern record-binding encryption
libraries require for the same reason), or write no encrypted field. The
mock REST work order is the in-repo example of the second case.

**4. Legacy envelopes are refused by default.** Accepting `tsenc1` at all
reopens the hole: an attacker replaces a bound value with any unbound
ciphertext of the same field from another record. So `tsenc1` is readable
only while `legacyUnboundEnvelopes: "read"` is set for a migration, and
`"refuse"` is the default, resolved once at construction.

**5. `reseal()` for migration and rotation.** `reseal(typeName, objectId,
stored)` takes a record's stored form and returns it re-encrypted under the
active key, bound to its id, with fresh blind indexes — accepting `tsenc1`
input, since migrating it is its purpose. The migration is: set
`legacyUnboundEnvelopes: "read"`, reseal every record through the
application's write path, set it back. The same call re-encrypts old values
after a key rotation (ADR-0033 point 5).

## Consequences

- A ciphertext swapped, copied, or moved between records is detected on
  read and fails closed; the ADR-0033 residual test now asserts detection.
- `seal` and the Action config change shape (the id is required). Nothing is
  published, so there are no external callers to break.
- An encrypted Type needs ids known before the write. For adapters that
  assign ids themselves, that means generating ids client-side or keeping
  encrypted fields out of those creates.
- A store sealed with `tsenc1` is unreadable after upgrading until it is
  resealed — by design, and loud (`DecryptionError`).

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **The migration window is the weak moment.** While
  `legacyUnboundEnvelopes: "read"` is on, a downgrade to any `tsenc1`
  ciphertext of the same field is accepted, and a swap that happened *before*
  migration gets bound in place by `reseal`. Keep the window short, and treat
  it as a change requiring approval.
- **The id is only as stable as the store's.** Binding assumes an object's
  id never legitimately changes; a store that re-keys records needs a
  reseal step in that operation.
- **Rows are bound; tables aren't.** Deleting an encrypted record, or
  restoring an older copy of the same record (a replay), is not detected.
  Freshness and completeness need the store's own controls (audit log,
  append-only history, backups under access control).
- The cryptographic construction still awaits review (ADR-0033).

## Alternatives Considered

- **Bind to a random per-record nonce stored in the row.** It travels with
  the ciphertext when the row is copied, so it detects nothing.
- **Bind at read time only ("trust on first read").** There is no first read
  to trust: the swap can happen before any.
- **Re-seal after an adapter-assigned-id create, through an update.** Needs
  every adapter to expose a generic update, and leaves a window where the
  record holds unbound ciphertext. Client-side ids are simpler and have no
  window.
- **Keep reading `tsenc1` indefinitely for compatibility.** Equivalent to not
  binding at all, since an attacker chooses which version to plant.
- **Bind the blind index to the record too.** A lookup by value has no record
  id to compute it with; verifying the index against the decrypted, bound
  value on every read already stops an edited index from redirecting a
  lookup.
