# 0059. Domain Packs: Versioned, Signed, Offline Archives with Checked Installs

## Status

*Amended (pressure review of PR #11):*

- `checkUpgrade` also compares protections, which the contract diff cannot
  see: every `x-policy` (object and property policies) and `x-provenance`
  entry (classification markings, authoritative sources) on the pack's
  Types, each Action's `authorizationPolicy`, and every data source and
  mapping. One removed or changed is a `protection-weakened` finding, so the
  upgrade is not safe whatever its version bump, and `typesys pack
  check-upgrade` exits 1. One added only tightens and is not a finding.
- `installPacks` plans against the registry it installs into
  (`InstallOptions.registry`; `installPacks` always passes it). A Type,
  Action or trait it already holds, or a data source or mapping it holds
  differently, is a `conflict` unless an installed pack defines it, since
  registering overwrites by name. With no overwrite allowed, the scratch
  registration covers everything the install touches.
- A pack defines Types only in its own domain: its name, or the domain its
  name starts with (`site-f16` defines `site.F16`). Anything else is
  `foreign-namespace`, found even when no registry is given.
- One pack defining the same Type, Action, data source, mapping or trait
  twice, differently, is a `conflict`. `buildPack` still builds such a pack;
  `planInstall` refuses it.
- Trusted keys, and binding keys, are looked up as own properties only: a
  key id such as `constructor` is untrusted, not a crash.
- Proven by `packages/packs/test/pressure-packs.test.ts` and the
  `check-upgrade` case in `packages/cli/test/pack.test.ts`.

Accepted. Implemented in:

- the new `@typesys/packs`, which provides `buildPack`, `verifyPack`, `signPack`, `planInstall`, `installPacks`, `manifestOf`, `checkUpgrade` and `corePack`;
- `@typesys/domain-airforce` (`airforcePack`) and `@typesys/domain-hospital` (`hospitalPack`);
- `@typesys/cli` (`typesys pack inspect | verify | sign | check-upgrade`);
- `@typesys/core`, which gains `canonical`, moved from `@typesys/workflow`, which re-exports it.

The archives are committed under `packs/`. `npm run packs` writes them, and `npm run packs -- --check` (also run as a test) fails when one has drifted from its domain.

Proven by:

- `packages/packs/test/packs.test.ts`:
  - The committed archives are exactly what the domains build, and each verifies.
  - Core and airforce installed from their files describe the same model as the domain registered from code. The resulting runtime answers the maintainer, the viewer and an anonymous caller identically on four reads, refusals included: an object with provenance, a filter on a computed value, the Actions on one object, and an Action preview.
  - Hospital installed from its file describes the same model as its testbed.
  - A changed schema fails its digest. Requirements stated smaller than the contents need are caught even when the digest was recomputed to match.
  - With trusted keys, an unsigned pack, a pack signed by an unknown key, and a signature that does not verify are each refused.
  - A tampered pack re-signed by a trusted key still fails on its digest.
  - One install attempt that lacks a dependency, three bindings, two policy rules and an adapter reports all nine problems and registers nothing.
  - A dependency outside its range, a requirement cycle, and two packs defining the same Type or Action are refused. Two packs declaring the same data source identically are not.
  - A Type the registry itself refuses is caught by the scratch registration, before the target registry changes.
  - A specialization pack (`site.F16` extends `airforce.Aircraft`) installs over a deployment's own description of a data source and composes the Aircraft's values. It keeps the Aircraft's protections: the viewer gets no maintainer-only or SECRET value (ADR-0060). Given without the pack it extends, it is refused.
  - An upgrade check:
    - passes an additive 1.1.0;
    - refuses a 1.0.1 that removes a value, showing the removal on the dependent's Type too;
    - refuses the same change as 2.0.0, because the dependent's `^1.0.0` excludes it;
    - refuses a pack bump whose changed Type kept its version;
    - refuses a re-release under the same version;
    - refuses an "upgrade" of a pack that is not installed.
  - A pack is not built from an inline precondition with no binding key, nor from a malformed name, version or range.
- `packages/cli/test/pack.test.ts`: `inspect` reports what a pack needs. `sign` then `verify --trust` passes; the wrong public key fails twice over (bad signature, untrusted). A pack edited after signing fails on its digest, and `sign` refuses to sign it. `check-upgrade` fails a re-release and an upgrade of a pack that is not installed.

Mutation-checked: 18 mutations, each failing at least one test.

- Verification: the digest unchecked; stated requirements trusted; a bad signature silent; an unsigned pack accepted; any key id's key accepted.
- Requirements: an Action's policy not required; references not required.
- Install: version ranges ignored; computed bindings unchecked; policies unchecked; adapters unchecked; conflicts ignored; everything treated as shareable; registering despite findings; the deployment's data source description ignored.
- Upgrade: dependents ignored; the version bump unchecked; a dependent blamed for an inherited change.

A 19th mutation, continuing the scratch registration after its first failure, changes only how many diagnostics are reported, not whether the install is refused. It is equivalent and was not counted.

## Context

A domain in TypeSys was TypeScript code: a `DomainManifest` imported from a package and registered at startup. That made a domain hard to move into the settings TypeSys is built for:

- An accredited enclave without package registry access cannot receive a new version as `npm install`.
- A site cannot add its own variant of a Type without forking the domain.
- Nothing said whether a new version of a domain would break the applications, agents and specializations built on the old one.

Two pieces already existed. ADR-0015 split behavior from data for durable registry stores: computed values and preconditions are named by binding key, and the process that reads them back supplies the code. ADR-0056's contract diff classifies every change by its impact on consumers. Domain packs reuse both rather than add a second serialization or a second notion of compatibility.

## Decision

**A pack is data, never code.** `buildPack` turns domain manifests into one JSON document (`typesys.pack/1`) that contains:

- Types, with their traits by name;
- trait definitions;
- Actions, each precondition by binding key;
- data sources and mappings;
- requirements derived from all of the above.

It refuses a computed value or precondition with no binding key, as a durable store does. Nothing in an archive executes on install. The code it names is supplied as a `BindingRegistry` by the deployment that installs it, from its own reviewed build.

**Requirements are derived, and recomputed on every check.** A pack's requirements are what a deployment must supply or another pack must provide:

- binding keys;
- policy rule names, from `x-policy` and each Action's `authorizationPolicy`;
- data source ids;
- the Types and Actions it names but does not contain.

Verification recomputes them from the contents and refuses a pack whose stated requirements differ. A pack cannot hide the policy rules or code it depends on by under-declaring them.

**Integrity by digest, authenticity by signature.**

- `digest` is SHA-256 over the canonical JSON of everything but the digest and signatures. Canonical JSON is `canonical`, now shared with the workflow replay check.
- `signPack` adds an Ed25519 signature over the digest, using `node:crypto` with no new dependency. Signatures can be added without changing the digest, so a release and an accreditor can both sign.
- With `trustedKeys`, verification requires at least one valid signature by a trusted key and reports any trusted key id whose signature fails.
- Key distribution and revocation are the deployment's.

**An install is planned completely before anything is registered.** `planInstall` checks, in order:

1. integrity and signatures;
2. that every required pack is present at a version in range;
3. that requirements form no cycle;
4. that no two packs define the same Type, Action, mapping, trait or data source differently;
5. that every named Type, Action and data source is provided by the pack or something it requires, transitively;
6. that every binding key has an implementation;
7. when the deployment lists them, every policy rule its engine has and every adapter it runs.

Every finding is reported at once. Only then does it register every pack into a scratch registry, which catches what only the registry knows (a schema that does not compile, a base Type missing). `installPacks` registers into the real registry only after a clean plan. It returns `{name, version, digest}` per pack for the deployment to record.

**Specialization is a pack that requires another.** A site extends a pack's Types (`extends`), adds its own Types, Actions and mappings, and states the range it accepts (`airforce: ^1.0.0`). This is the model's own extension mechanism (ADR-0004), so a specialization gets the composed schema and computed values like any subtype. It also keeps the base's property policies and markings, which, until this slice, registration dropped; see ADR-0060. A deployment may also describe a pack's data source in its own terms, such as name, kind and config, without changing the id the pack's mappings and code use.

**Upgrades are checked against everything installed.** `checkUpgrade(installed, next)` works offline, with stub bindings that never run. It:

- describes the installed model and the model with `next` in place;
- runs the contract diff across the whole model, so a value removed from `airforce.Aircraft` also shows on `site.F16`;
- requires the pack version to move as far as the changes need (breaking means major; any change means minor; before 1.0, a minor counts as major);
- requires each of its own changed Types and Actions to have moved too;
- refuses the upgrade when an installed dependent's range excludes the new version or the new set no longer installs.

A dependent's inherited change is shown but not held against the dependent's version, which its author did not touch.

**The demo domains ship as packs.** `corePack`, `airforcePack` and `hospitalPack` are built from the same manifests the code paths register, committed under `packs/`, and checked for drift. The equivalence test holds the archive path to the code path.

## Consequences

- A domain can be moved, reviewed and installed as one file, by hash and signature, with no network. `typesys pack inspect` shows a reviewer exactly what code, policy rules and data sources a pack will need before it is accepted.
- Installs fail closed and complete: no partially registered domain, and no install that fails one missing binding at a time.
- A domain's compatibility promise is checked mechanically against what is actually installed, including other teams' specializations.
- Measured: verifying both demo archives takes about 0.2 ms; reading and installing core and airforce from files takes about 21 ms at p50, about half of it the scratch registration ([evidence](../evidence/packs-2026-10-13.md)).
- Not done:
  - Packs do not carry workflows, which are code (ADR-0057), nor sample data.
  - YAML domains cannot yet be packed, because YAML authoring has no data sources or mappings.
  - The lock is returned, not persisted.
  - There is no registry of published packs, and no key revocation.
  - Uninstalling a pack is not supported; the registry has no removal.
  - Core relationships whose source is the placeholder `unresolved` are treated as abstract and need no adapter.

## Alternatives Considered

- **npm packages as the unit.** Already how the demo domains ship, and right for code. But installing executes install scripts and pulls a dependency tree, and an air-gapped site cannot run it. A pack keeps code and data apart: code arrives through the deployment's own reviewed build, and data arrives as a file anyone can read.
- **OCI artifacts or Sigstore.** A good transport and signing ecosystem, and a pack can be carried as an OCI artifact unchanged. Requiring it would put a registry and online transparency logs in the install path, which the offline case cannot have. A detached Ed25519 signature over the digest works offline and composes with either later.
- **Trusting the stated requirements.** Simpler, but a pack could then under-declare the policy rules or code it needs. Recomputing costs about 0.1 ms per pack.
- **Overlays that patch a pack's Types in place.** Flexible, but a patch is a fork the upstream cannot see, and the contract diff could not tell a consumer what changed. Extension keeps the upstream Type intact and its changes visible.
