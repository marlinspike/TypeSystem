# 0069. Pack Trust Can Be Revoked, and Every Install Is Audited

## Status

Accepted (2026-10-14). Implemented in `@typesys/packs` (`revokedKeys`,
`revokedDigests` and `actor` on `verifyPack` and `installPacks`,
`revocationsOf`, the `revoked` diagnostic, one `pack.install` audit row per
`installPacks` call) and `@typesys/cli` (`typesys pack verify --revoke`).
Proven by `packages/packs/test/revocation.test.ts` and
`packages/cli/test/pack.test.ts`.

## Context

ADR-0059 signs packs with Ed25519 and lets a deployment require a
signature by a trusted key. It said "distributing and revoking keys is
yours", and nothing helped: a deployment that learned a release key was
exposed could only delete the key from its trust map, which does nothing
about a pack that key co-signed with another, nothing about packs already
installed, and leaves no trace of who installed what. A defective release
(right signer, wrong contents) had no way to be withdrawn at all. And
installs were not audited, although an install changes every policy,
marking and Action a runtime enforces.

## Decision

**A revocation is by key id or by digest, and it is absolute.** A pack
carrying any signature by a revoked key id is refused, verified or not,
listed in the trusted keys or not, and whatever else signed it: the
signature says the pack passed through the revoked key's holder, and a
deployment that still wants it can have a trusted key sign it again (which
never changes the digest). A withdrawn digest refuses that one build. Each
revocation may carry `revokedAt` and `reason`, which are reported, not
used to date signatures: a signature carries no trustworthy time, so a
revocation applies to everything the key ever signed.

**Revocation reaches what is installed.** `planInstall` checks the
installed packs against the revocations too, and refuses any further
install while one of them is revoked, so a deployment learns of it at its
next change instead of never.

**Every install is audited.** `installPacks` writes one `pack.install` row
to the registry's audit log, allowed or refused, naming the actor, every
pack offered with its digest and signers, whether signatures were
required, and on a refusal every diagnostic by code. Nothing else changes
about installs: everything is still checked before anything is registered.

## Consequences

- A compromised key or a bad release is one line of configuration away
  from being refused everywhere that configuration reaches, including on a
  disconnected install, which needs only the updated options.
- Co-signing no longer lets a good key launder a pack a revoked key
  touched; that is deliberate, at the cost of a re-signing step. As first
  written this did not hold against the revoked key's holder, who could
  strip their own signature; the amendment below binds co-signers.
- Not addressed: distributing revocation lists (a signed list, or a
  transparency log), key validity periods, `checkUpgrade` (a contract
  check; the upgraded pack's trust is checked when it is installed), and
  removing a revoked pack from a registry (packs have no uninstall).

## Amended after the independent review (2026-10-14)

The review ([`docs/reviews/m2-adversarial-review.md`](../reviews/m2-adversarial-review.md))
showed that the claim above about co-signing did not hold against the
revoked key's own holder. It found four more gaps. All are fixed, each with
its test and a catalogued mutation:

- **Co-signers are bound (M9).** A signature now signs the digest together
  with the sorted key ids that had signed before it (`PackSignature.after`).
  Stripping or renaming an earlier signature leaves every later signature
  still naming the earlier signer. Every key id a pack's signatures name is
  checked against revocations. A first signature, with no `after`, signs the
  digest alone as before, so packs signed earlier still verify. One case is
  out of reach. If a good key signed before the revoked one, stripping the
  revoked key's signature leaves exactly the pack the good key vouched for,
  and that pack verifies.
- **A key, not a name (L8).** A revocation applies to the key: whatever
  other id the same public key is trusted under is revoked too, by the
  fingerprint of its SPKI encoding. A `Revocation` can carry `publicKey` for
  a key that is not among the trusted keys.
- **What is installed (M10).** Every `pack.install` row records each pack
  it registered, with every key id its signatures name. A later install
  checks revocations against every pack the registry's audit trail records,
  as well as those the caller lists in `installed`.
  `RegistryStore.listAuditEvents` gained an `action` filter, with a Postgres
  index, so this reads only install rows.
- **Every attempt audited (M11).** `installPacks` writes its audit row in a
  `finally` block, so a malformed offer, a refusal and a failure part way
  through registering are all recorded. A partial registration records the
  packs it touched.
- **Digests (L9).** `typesys pack verify --revoke` reads a digest in any
  case, with or without its `sha256:` prefix, and rejects a malformed one.
  `verifyPack` compares digests without regard to case.
