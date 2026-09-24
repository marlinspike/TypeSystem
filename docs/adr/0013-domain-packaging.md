# 0013. Domain Packaging

## Status

Accepted

## Context

"The core must know nothing about aircraft" — domain models (Air Force,
healthcare, manufacturing, commercial, or anything else) must be
installable, independently versioned units that extend the platform without
requiring changes to the runtime itself. A customer should be able to
create their own domain package without modifying anything the platform
team owns.

## Decision

Structure domains as independent **npm workspace packages** under
`packages/*`, each exporting a `DomainManifest`
(`packages/core/src/registry/manifest.ts`): `{domain: string, types:
DomainTypeEntry[], actions?: ActionDefinition[], dataSources?: DataSource[],
mappings?: Mapping[]}`, registered with a single function,
`registerDomain(registry, manifest)`, which registers data sources, then
types (in manifest order, so `extends` targets are already registered when
their subtypes register), then actions, then mappings.

`packages/core` (`@typesys/core`) exports only `coreManifest` — `Party`,
`Person`, `Organization`, `Location`, `Asset`, `Event` — and contains zero
references to any domain concept. `packages/domain-airforce`
(`@typesys/domain-airforce`) is a peer package (a `dependency` on
`@typesys/core`, `@typesys/adapter-in-memory`, `@typesys/adapter-mock-rest`
— never the reverse) that authors `airforceManifest` in exactly this shape
and registers it the same way any other domain would:
`await registerDomain(registry, coreManifest); await
registerDomain(registry, airforceManifest);`
(`packages/domain-airforce/src/setup.ts`). The MCP server's bootstrap
(`packages/mcp-server/src/server.ts`) is the only place a domain package
needs to be wired in at all — `resources.ts`/`tools.ts` are generic over
whatever the registry happens to hold, with no `airforce`-specific code in
either file.

`docs/developer-guide/adding-a-domain.md` (also written for this project)
generalizes the pattern by building a second domain, Hospital, from scratch
without touching `packages/core/src` — the concrete proof that the
architecture is domain-neutral in practice, not just in principle.

## Consequences

- A new domain is, mechanically, a new npm workspace package plus one call
  to `registerDomain()` — no runtime, registry, or MCP server source change
  is required to add it (adapters/data sources for real backing systems are
  a separate, domain-specific concern — see ADR-0006 — not a runtime
  change).
- Domain packages can depend on `@typesys/core` and on shared adapter
  packages, but `@typesys/core` can never depend on a domain package —
  enforced structurally by the workspace dependency graph, not just by
  convention.
- Multiple domains can coexist in one registry (as core + airforce already
  do); nothing about `registerDomain()` assumes only one domain is ever
  registered.
- A customer's own domain package (e.g. `/customers/acme`) follows exactly
  this same shape — the mission brief's requirement that customers be able
  to create domain packages "without modifying the runtime" is satisfied by
  construction, not by a separate customer-specific mechanism.

## Alternatives Considered

- **A plugin/registry-discovery mechanism** (domains auto-discovered from a
  directory or a package-naming convention, dynamically loaded at
  runtime): rejected as unneeded complexity for this pass — explicit
  `registerDomain()` calls in a bootstrap file are simpler, statically
  type-checked, and make exactly what's registered, and in what order,
  visible in one place, rather than implicit in a naming convention or
  filesystem scan.
- **Domain Types living inside `packages/core` behind feature flags**:
  rejected outright — it would violate "the core must know nothing about
  aircraft" directly, and would force every domain's dependencies (however
  small) into the core package's own dependency tree.
