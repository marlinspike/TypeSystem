---
"@typesys/encryption": minor
---

Record-bound encryption envelopes (ADR-0035). New writes produce `tsenc2` envelopes whose authenticated data includes the record's id, so a ciphertext moved to another record fails authentication. `seal(typeName, objectId, values)` now takes the record id; `EncryptionConfig.actions` maps each Action to `{ type, idField }` (or `null`), and an Action whose input carries encrypted fields without an id is refused before the adapter runs, while its result is unsealed under its own id. Unbound `tsenc1` envelopes are refused unless `legacyUnboundEnvelopes: "read"` is set for a migration, and the new `reseal(typeName, objectId, stored)` rewrites a stored record bound to its id under the active key, for migration and key rotation.
