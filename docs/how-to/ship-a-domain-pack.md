# How to ship a domain as a pack

A pack is one JSON file holding a domain's Types, traits, Actions, data
sources and mappings, content-addressed and optionally signed, that a
deployment installs with no network
([ADR-0059](../adr/0059-domain-packs.md)). It carries no code: computed
values and preconditions are named by binding key, and the deployment
supplies them from its own reviewed build.

## 1. Build the pack

From the manifests you already register:

```ts
import { buildPack } from "@typesys/packs";

export const fleetPack = buildPack({
  name: "fleet",
  version: "1.0.0",
  description: "Vehicles and their maintenance.",
  requires: { core: "^1.0.0" },          // fleet.Vehicle extends core.Asset
  manifests: [fleetManifest]
});
```

Every computed value needs its `binding` key and every precondition a
`bindingId`, as for a durable registry store (ADR-0015); `buildPack`
refuses one without. Write the archive to a file the deployment receives:

```ts
await writeFile(`fleet-${fleetPack.version}.typesys-pack.json`, JSON.stringify(fleetPack, null, 2));
```

The demo domains' archives are in [`packs/`](../../packs), written by
`npm run packs` and checked for drift by `npm run packs -- --check`.

## 2. Sign it

```bash
openssl genpkey -algorithm ed25519 -out release.pem
openssl pkey -in release.pem -pubout -out release.pub
typesys pack sign fleet-1.0.0.typesys-pack.json --key-id fleet-release --private-key release.pem --out fleet-1.0.0.signed.json
```

Signing never changes the digest, so a release team and an accreditor can
both sign the same pack. Distributing and revoking keys is yours.

## 3. Review and verify it where it lands

```bash
typesys pack inspect fleet-1.0.0.signed.json
typesys pack verify fleet-1.0.0.signed.json --trust fleet-release=release.pub
```

`inspect` lists what the pack will need: binding keys, policy rule names,
data sources and the packs it requires. These are recomputed from its
contents on every verification, so a pack cannot under-declare them.

## 4. Install it

```ts
import { installPacks, corePack } from "@typesys/packs";

const lock = await installPacks(registry, [corePack, fleetPack], {
  bindings: fleetBindings,                       // { computed: {...}, preconditions: {...} }
  trustedKeys: { "fleet-release": releasePub },  // optional: refuse unsigned packs
  policies: Object.keys(fleetPolicyRules),       // optional: refuse rule names your engine lacks
  adapters,                                      // optional: refuse data sources nothing serves
  dataSources: { "fleet-db": { kind: "postgres", name: "Depot database" } }   // your source, same id
});
// lock: [{ name, version, digest }, ...], to record what is installed
```

Nothing is registered unless everything checks: integrity and signatures,
dependency ranges, conflicts between packs, references nothing provides,
bindings, policy rules, adapters, and a registration into a scratch
registry. Every problem is reported at once in the `PackError`.
`planInstall` runs the same checks without installing.

## 5. Specialize it without forking

A site's own Types go in a pack that requires the one it extends:

```ts
const wingPack = buildPack({
  name: "wing-f16",
  version: "1.0.0",
  description: "This wing's F-16s.",
  requires: { airforce: "^1.0.0" },
  manifests: [{ domain: "wing", types: [F16Type /* extends airforce.Aircraft */], mappings: [f16Mapping] }]
});
```

A subtype keeps everything its base protects: property policies and
classification markings are inherited, and a subtype may add to them but
not replace them ([ADR-0060](../adr/0060-subtypes-keep-their-base-protections.md)).

## 6. Check an upgrade before taking it

```bash
typesys pack check-upgrade fleet-2.0.0.typesys-pack.json \
  --installed core-1.0.0.typesys-pack.json --installed fleet-1.0.0.typesys-pack.json --installed wing-f16-1.0.0.typesys-pack.json
```

It runs the contract diff (ADR-0056) across everything installed, so a
value removed from a base Type also shows on every subtype. It fails when:

- the pack's version did not move as far as its changes need (breaking
  means major);
- one of its changed Types or Actions kept its version;
- an installed dependent's range excludes the new version;
- the new set no longer installs.

From code, `checkUpgrade(installed, next)` returns the same report.
