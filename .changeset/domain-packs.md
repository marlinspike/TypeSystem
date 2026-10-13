---
"@typesys/packs": minor
"@typesys/cli": minor
"@typesys/domain-airforce": minor
"@typesys/domain-hospital": minor
"@typesys/core": minor
"@typesys/workflow": patch
---

Domain packs (ADR-0059). New `@typesys/packs`: `buildPack` turns domain manifests into one content-addressed JSON archive with no code in it; `signPack` and `verifyPack` add and check Ed25519 signatures and recompute requirements from contents; `planInstall` and `installPacks` check integrity, dependency ranges, conflicts, unresolved references, bindings, policy rules, adapters and a scratch registration before registering anything; `checkUpgrade` runs the contract diff across everything installed and checks the version bump and every dependent's range. The airforce and hospital domains export `airforcePack` and `hospitalPack`, and `corePack` covers the base Types. The CLI adds `typesys pack inspect | verify | sign | check-upgrade`. Core gains `canonical` (moved from the workflow package, which re-exports it).
