# @typesys/encryption

Field-level encryption at rest for TypeS. `EncryptingAdapter` wraps any
`Adapter` so the configured fields are ciphertext in every store behind it
— database rows, backups, replicas, a remote system — while the runtime,
and everything it enforces, sees plaintext. Keys come from a `KeyProvider`.
See [ADR-0033](../../docs/adr/0033-field-level-encryption.md).

## Use it

```ts
import { EncryptingAdapter, LocalKeyProvider } from "@typesys/encryption";

const keys = LocalKeyProvider.fromEnv(); // TYPESYS_ENCRYPTION_KEYS="2026-09:<base64 32 bytes>,2026-06:<…>"
const patients = new EncryptingAdapter(new PostgresRepositoryAdapter(pool, "hospital-pg"), keys, {
  fields: {
    "hospital.Patient": {
      medicalRecordNumber: { mode: "deterministic" }, // equality still works
      dateOfBirth: {} // randomized: nothing but a decrypt reveals it
    }
  },
  // Every Action this adapter executes: the Type its input writes, or null.
  actions: { RegisterPatient: { type: "hospital.Patient", idField: "id" } }
});

const { runtime } = await buildRuntime({ manifests, adapters: [patients], policyRules });
```

Bulk loads that use an adapter's own write method encrypt first:

```ts
await pg.put("hospital.Patient", id, await patients.seal("hospital.Patient", id, record));
```

## What you get, and what you give up

| | randomized (default) | deterministic |
|---|---|---|
| Stored as | AES-256-GCM, fresh IV every write | the same, plus an HMAC-SHA-256 blind index (`__bidx_<field>`) |
| `eq`, `ne`, `in` filters | refused | work, through the index |
| range, `contains`, search, sort, aggregate, relationship keys | refused | refused |
| The store learns | nothing | which records share a value |

A refused operation throws `EncryptedFieldError` (an `InvalidInputError`)
naming the field and what to do instead. A default `search` ranges over every
property, so on a Type with an encrypted field, name `search.properties`.

## It fails closed

- A value that isn't a valid envelope, names a key the keyring doesn't
  hold, or fails the GCM tag — tampered, truncated, moved to another record,
  field, or Type, or read with the wrong key — throws `DecryptionError`; the
  read fails and nothing is returned. The message names the Type, field, and
  object, never a value. Every envelope (`tsenc2`) is bound to its record
  ([ADR-0035](../../docs/adr/0035-record-bound-encryption-envelope.md)), so a
  write must name the record: `seal(type, id, values)`, and an Action names
  the input field that carries the id.
- Unbound `tsenc1` envelopes from before record binding are refused unless
  `legacyUnboundEnvelopes: "read"` is set for a migration; `reseal(type, id,
  stored)` rewrites them bound, and re-encrypts under the active key after a
  rotation.
- A deterministic field's blind index is checked against its decrypted value
  on every read, so an edited index can't make a lookup return another
  record.
- An Action the config doesn't list is refused (`EncryptionConfigError`): it
  might write a protected field in plaintext.
- Plaintext already in a field you start encrypting is unreadable until it
  is re-written through `seal`.

## Keys and rotation

A `KeyProvider` answers three questions — the active key, a key by id, and
every key — and the adapter derives separate HKDF subkeys for encryption and
for each field's blind index. `LocalKeyProvider` holds a keyring in memory
(for development and tests; production wants a KMS-backed provider behind
the same interface). To rotate, add a new key and make it active: old values
name their key and keep decrypting, equality lookups match indexes written
under any key in the ring, and new writes use the new key. Removing a key
makes whatever is still under it unreadable.

## Before production

Read the review lists in ADR-0033 and ADR-0035: the construction is
unreviewed by a cryptographer, the legacy-migration window accepts
downgrades while it's open, deleting or replaying a whole record isn't
detected, and the runtime's cache holds decrypted values — don't cache
encrypted Types.
