---
"@typesys/packs": minor
"@typesys/cli": minor
---

Pack trust can be revoked (ADR-0069). `verifyPack` and `installPacks` take `revokedKeys` and `revokedDigests`: a pack any revoked key signed, or a withdrawn build, is refused with the new `revoked` diagnostic, and an installed pack that is revoked blocks further installs. `installPacks` writes a `pack.install` audit row for every attempt (`actor` names who). `typesys pack verify --revoke <keyId|sha256:digest>`.
