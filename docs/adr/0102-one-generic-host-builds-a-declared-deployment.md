# 0102. One Generic Host Builds a Declared Deployment

## Status

Accepted (2026-11-02). The first step of the deployment design
(`/mnt/project-files/reviews/deployment-design-pressure-test.md`): findings
H1 (shared mutable registry) and H2 (governance is code), with live build
switching deferred (Reuben, 2026-10-31: restart on change is enough for now).
Implemented in `packages/host` (`deployment.ts`, `host.ts`, `load.ts`,
`serve.ts`), with every shipped host moved onto it:
`packages/cold-chain/src/setup.ts` and `recalls.ts`,
`packages/sortie-readiness/src/setup.ts`, and
`packages/demo-web/src/deployments.ts` for the airforce and hospital
demonstrations. The files are in `deployments/`, written by
`npm run deployments`. Proven by `packages/host/test/*.test.ts`,
`packages/demo-web/test/deployments.test.ts` and each domain's own suite,
unchanged.

## Context

Each domain had its own `buildXHost`: TypeScript that registered manifests,
constructed adapters with credentials in code, compiled rules and chose a
classification. Upgrading a deployment meant a new image of that code, and
every deployment was a different program. The image ran the airforce
testbed and nothing else.

## Decision

A deployment is a document, `typesys.deployment/1`:

- `packs`: the model, by name, version and (optionally) digest (ADR-0059).
- `sources`: every system the runtime may reach, by data source id. An
  `http` source is `@typesys/adapter-http`'s mapping as data, with its
  address as an `$env` reference and its credential as a `$secret`
  reference; an `extension` source is supplied by named code.
- `policies`: rules as data (ADR-0100).
- `classification`, `identity` (OIDC, demo tokens, or an extension's
  resolver), `personas`, `runtime` (call timeout, inspection policy),
  `trust` (signing keys and revocations, ADR-0069), `consumers` (ADR-0103).
- `extensions`: code it needs, by installed package specifier only. An
  extension supplies bindings, adapters for its sources (or decorators of
  declared ones), and an identity resolver. It adds no Type, rule or source
  the document does not declare.

`buildHost` checks everything before building anything and reports every
problem at once: the packs offered are exactly those listed (version and
digest), every named extension is supplied and none other, every declared
source is one a pack declares, every adapter returned is for a declared
source and the extension it belongs to, no code rule shadows a declared
one, and nothing a pack names is missing (`installPacks` plans first). The
registry is the process's own, filled from the packs, so a replica booting
a new build never changes what another replica serves (H1).

A demonstration is marked `demo: true`. Only a demo may hold a literal
credential, a `$secret` default, fixed tokens, or the demonstration
classification; a real deployment is refused if it does.

`typesys-host <deployment.json>` (`packages/host/dist/serve.js`) is the one
server: MCP at `/mcp`, the governed API under `/api`, `GET /version` naming
the build. The Docker image runs it on `TYPESYS_DEPLOYMENT`, default the
airforce demonstration; Kubernetes mounts the file from a ConfigMap. An
upgrade is a new file or a new image, checked (ADR-0104), then a restart.

## Consequences

The cold chain, the recall exchange and sortie readiness are deployments
with no code but one extension (the recall hold, a loop with compensation no
single request can express). The airforce and hospital demonstrations need
an extension only because their systems are in memory and seeded. Each
in-process builder (`buildColdChainHost` and the others) is now a thin
wrapper over `buildHost` with its package's deployment, and the file in
`deployments/` is that same deployment written out, so both build to the
same build id; a drift test keeps them equal.

Not done here, on purpose: hot activation of a new build, pulling signed
builds from a registry, and out-of-process adapters. An extension is
trusted code in the host's process, and two builds of one process share one
copy of each extension module.
