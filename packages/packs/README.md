# @typesys/packs

Domain packs for TypeSys ([ADR-0059](../../docs/adr/0059-domain-packs.md)):
a domain's Types, traits, Actions, data sources and mappings as one JSON
archive, content-addressed by SHA-256 and optionally signed with Ed25519,
installed offline with every requirement checked before anything is
registered.

```ts
import { buildPack, installPacks, checkUpgrade, corePack } from "@typesys/packs";

const pack = buildPack({ name: "fleet", version: "1.0.0", description, requires: { core: "^1.0.0" }, manifests: [fleetManifest] });
const lock = await installPacks(registry, [corePack, pack], { bindings, policies, adapters, trustedKeys });
const report = await checkUpgrade(installedArchives, nextArchive);   // contract diff, version bump, dependents
```

A pack carries no code. It names its computed values and preconditions by
binding key, and the deployment supplies the implementations. The CLI's
`typesys pack inspect | verify | sign | check-upgrade` works on the files.

See [`docs/how-to/ship-a-domain-pack.md`](../../docs/how-to/ship-a-domain-pack.md).
