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
  touched; that is deliberate, at the cost of a re-signing step.
- Not addressed: distributing revocation lists (a signed list, or a
  transparency log), key validity periods, `checkUpgrade` (a contract
  check; the upgraded pack's trust is checked when it is installed), and
  removing a revoked pack from a registry (packs have no uninstall).
