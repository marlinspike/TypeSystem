# TypeS Documentation

Everything here is organized by what you're trying to do, not by which
package happens to hold the code. If you're an AI agent looking for the
most token-efficient map of this repo, read [`llms.txt`](../llms.txt) at
the repo root first — this page is the fuller, human-oriented index it
points into.

## New here?

1. **[Why TypeS?](why-typesys.md)** — when to use this, when not to, how
   it compares to a hand-rolled BFF, GraphQL federation, and the
   Palantir/C3 platforms it takes inspiration from without cloning.
2. **[Quickstart](quickstart.md)** — clone to a working, policy-gated
   query in about ten minutes. Every command is verified against this
   exact repo.
3. **[Completeness](completeness.md)** — an honest, kept-current
   inventory: what's fully built and tested versus a documented,
   not-yet-built extension point. Read this before assuming a capability
   exists just because an ADR discusses it.
4. **[Production readiness](PRODUCTION-READINESS.md)** — the ranked list
   of what stands between this reference implementation and real
   production traffic, kept current as items are actually closed. Read it
   before betting production traffic on any of this.

## Building something? (how-to guides)

Task-first, assume you've done the quickstart. Each one is short on
purpose — for the *why* behind a pattern, it links out to the relevant ADR
instead of re-explaining it.

| Guide | When you need it |
|---|---|
| [`add-a-type.md`](how-to/add-a-type.md) | Define a new object shape — properties, `extends`, traits. |
| [`add-a-relationship-and-action.md`](how-to/add-a-relationship-and-action.md) | Connect Types, and add a governed capability that acts on them. |
| [`write-an-adapter.md`](how-to/write-an-adapter.md) | Back a Type with a real system instead of the in-memory adapter. |
| [`add-a-policy-rule.md`](how-to/add-a-policy-rule.md) | Gate a Type/property/Action by role or attribute. |
| [`classify-data.md`](how-to/classify-data.md) | Mark a Type, property, or value with a classification and enforce readers' clearances. |
| [`encrypt-fields.md`](how-to/encrypt-fields.md) | Keep sensitive fields as ciphertext in the store, with equality lookups where you need them. |
| [`enable-caching.md`](how-to/enable-caching.md) | Stop re-fetching data that doesn't change every request. |
| [`enable-rate-limiting-and-concurrency-bounds.md`](how-to/enable-rate-limiting-and-concurrency-bounds.md) | Cap how fast one caller can call, how many adapter calls one request can have in flight, and how much one query can ask for. |
| [`enable-observability.md`](how-to/enable-observability.md) | See real traces/metrics for this runtime in your own OTel backend. |
| [`use-postgres.md`](how-to/use-postgres.md) | Make the registry survive a restart. |
| [`generate-typescript-types.md`](how-to/generate-typescript-types.md) | Get autocomplete/type-safety for objects this registry returns. |
| [`run-multiple-instances.md`](how-to/run-multiple-instances.md) | Run several replicas with a shared cache and rate limiter, and load-test them. |
| [`run-mcp-over-http.md`](how-to/run-mcp-over-http.md) | Serve the MCP server to a real network client instead of a local stdio process. |
| [`deploy-with-containers.md`](how-to/deploy-with-containers.md) | Run the MCP server as a container, locally with Docker Compose, and as reference Kubernetes manifests. |
| [`combine-multiple-sources.md`](how-to/combine-multiple-sources.md) | Stitch one object's (or one graph's) data together from more than one backend system. |

## Building an AI agent integration?

**[`for-agents.md`](for-agents.md)** — procedural, not architectural: the
exact MCP resource URIs and tool call shapes, the auth model, and a
complete worked request/response example against the shipped demo domain.
Written to be followed by an agent directly, not just read by the person
building one.

## Reference

- **[`semantic-meta-model.md`](semantic-meta-model.md)** — the canonical
  contracts (Type, Property, Relationship, Action, ComputedProperty,
  Policy, DataSource, Mapping, audit/Event), with real field names.
- **[`architecture.md`](architecture.md)** — the layered architecture,
  with Mermaid diagrams for the component layout, a cross-adapter query,
  and a governed Action invocation.
- **[`developer-guide/adding-a-domain.md`](developer-guide/adding-a-domain.md)** —
  the code-authored (not YAML) path for adding a whole new domain, proven
  by walking through a second one (Hospital) without touching
  `packages/core`.

## Explanation — architecture decision records

Every major, hard-to-reverse choice, in the order it was made, each with
alternatives actually considered and why they were rejected — the fastest
way to understand *why* something is shaped the way it is instead of some
other reasonable way.

| ADR | Decision |
|---|---|
| [0001](adr/0001-canonical-schema-representation.md) | JSON Schema 2020-12 + a private `x-*` vocabulary as the canonical Type representation. |
| [0002](adr/0002-type-identity.md) | Logical namespaced name, registry ULID, and semver version — three separate concepts, kept independent. |
| [0003](adr/0003-relationships-as-first-class-records.md) | Relationships are first-class `RelationshipDefinition` records, not nested JSON. |
| [0004](adr/0004-composition-via-allof-not-dynamicref.md) | `extends`/traits compose via plain `allOf`+`$ref`, not `$dynamicRef`. |
| [0005](adr/0005-actions-as-first-class-governed-capabilities.md) | Actions are governed capabilities separate from semantic objects, mapped 1:1 to MCP tools. |
| [0006](adr/0006-adapter-architecture.md) | `DataSource` + `Mapping` + `Adapter`; two adapter styles prove substitutability. |
| [0007](adr/0007-runtime-resolution-modes.md) | `live`/`materialized`/`cached` resolution modes (see ADR-0016 for `cached`'s real implementation). |
| [0008](adr/0008-provenance-model.md) | Provenance is opt-in per read, never inlined into every response by default. |
| [0009](adr/0009-embedded-abac-policy-engine.md) | A small embedded ABAC `PolicyEngine`, swappable for OPA/Cedar later. |
| [0010](adr/0010-schema-versioning-and-aliasing.md) | Semver versioning plus an alias/deprecation mechanism for backward compatibility. |
| [0011](adr/0011-query-dsl-not-graphql.md) | A structured JSON query DSL instead of GraphQL or a bespoke language. |
| [0012](adr/0012-mcp-mapping-and-stateless-identity.md) | MCP Resources = browsing, Tools = Actions + `query`; identity resolved fresh on every call. |
| [0013](adr/0013-domain-packaging.md) | Domain packages are added, never edited into, a shared core. |
| [0014](adr/0014-registry-store-persistence.md) | `RegistryStore` as an interface, with only an in-memory implementation at the time. |
| [0015](adr/0015-postgres-registry-store.md) | The production PostgreSQL `RegistryStore`, with a `BindingRegistry` seam for behavior a database can never store. |
| [0016](adr/0016-caching.md) | A TTL-based `Cache`, opt-in per mapping, caching pre-redaction raw values so it's safe for every identity. |
| [0017](adr/0017-observability.md) | OpenTelemetry tracing/metrics via the API package only — a true no-op unless an application registers a real SDK. |
| [0018](adr/0018-oidc-identity-resolution.md) | Real OIDC/JWT identity resolution (`@typesys/auth-oidc`, `jose`), fail-open-to-anonymous by default, dropped in behind the existing `IdentityResolver` parameter. |
| [0019](adr/0019-concurrency-bounds-and-rate-limiting.md) | Bounded-concurrency fan-out for every relationship/query/provenance resolution, plus an opt-in per-identity token-bucket `RateLimiter`. |
| [0020](adr/0020-publish-infrastructure.md) | Real npm publish infrastructure (metadata, changesets, a gated release workflow) — deliberately stopping short of an actual `npm publish`. |
| [0021](adr/0021-http-transport.md) | A stateless Streamable HTTP transport for MCP, with identity from a real `Authorization` header. |
| [0022](adr/0022-cross-source-computed-properties.md) | A computed property's binding function can call `ctx.getAdapter()` on any registered adapter, not just its own — proven with `Aircraft.needsAttention`. |
| [0023](adr/0023-multi-source-property-composition.md) | `getObject`/`query` merge a Type's base wildcard mapping with per-property overrides from other DataSources into one object read. |
| [0024](adr/0024-production-readiness-gap.md) | The decision to document (not close) the production-readiness gap in this pass; the ranked list itself lives in [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md). |
| [0025](adr/0025-multi-instance-deployment.md) | Shared Redis `Cache`/`RateLimiter` for multiple replicas, advisory-locked migrations, one concurrency budget per request, and a load test that proves them. |
| [0026](adr/0026-adapter-call-resilience.md) | Per-adapter-call timeout + `AbortSignal` cancellation, idempotent-only retries with backoff, a per-DataSource circuit breaker, and reconciled `maxConcurrency`/pool defaults. |
| [0027](adr/0027-query-dsl-extensions.md) | Sort, projection (`select`), a separate `aggregate` query + tool, and full-text `search` desugaring to a uniform `icontains` operator — all optional, all fail-closed under policy. |
| [0028](adr/0028-relationship-resolution-strategies.md) | Relationships beyond foreign keys: a closed, parsed strategy set (`byJoinTable`, `byCompositeKey`) plus bounded, ordered traversal (`maxRelatedPerObject`, include `sort`/`limit`). |
| [0029](adr/0029-deployment-artifacts.md) | A multi-stage `Dockerfile`, `docker-compose` topology, reference Kubernetes manifests, and `/healthz`/`/readyz` — making ADR-0025's multi-replica design runnable. |
| [0030](adr/0030-row-level-authorization.md) | Row-level authorization: policies decide on the object's own stored attributes, per item in `query` (denied rows dropped), with member policies that narrow rather than replace, and a deny-biased enforcement point. |
| [0031](adr/0031-cedar-policy-engine.md) | A Cedar `PolicyEngine` (`@typesys/policy-cedar`), in-process via WebAssembly: policy names as Cedar actions, the schema as the attribute allow-list, strict validation at load, fail-closed on any error — proven decision-for-decision identical to the ABAC engine on both demo domains. |
| [0032](adr/0032-data-classification-enforcement.md) | Data classification: `Identity.clearance` must dominate a Type's, a member's, and a value's markings under a pluggable `ClassificationScheme`, enforced beside the policy engine on every read path, derived data inheriting its inputs' markings, fail-closed on anything unrecognized. |
| [0033](adr/0033-field-level-encryption.md) | Field-level encryption at rest: an `EncryptingAdapter` decorator around any adapter (AES-256-GCM, HMAC blind indexes for equality), a `KeyProvider` seam with a keyring for rotation, and every operation that would need plaintext in the store refused. |
| [0034](adr/0034-classification-scheme-defaults.md) | Classification scheme naming and defaults: `US_CLASSIFICATION` renamed `DEMO_LINEAR_CLASSIFICATION` (it isn't the US model), and an explicit `DENY_MARKED_DATA` default so marked data is denied until a scheme is configured. |
| [0035](adr/0035-record-bound-encryption-envelope.md) | Record-bound encryption envelopes (`tsenc2`): every ciphertext is bound to its record, writes must name the record, unbound legacy envelopes are refused outside a migration, and `reseal` migrates and re-keys. |
| [0036](adr/0036-sensitive-data-caching.md) | Sensitive-data caching: caches declare whether they are confidential, adapters declare protected fields, the runtime keeps encrypted and marked data — and what derives from it — out of any cache that isn't, and `EncryptedCache` makes a shared cache confidential. |
| [0037](adr/0037-kms-backed-key-provider.md) | KMS-backed key provider: data keys wrapped by a KMS key, unwrapped at startup or not at all, and leased so a revoked KMS key stops every use within a bounded time; AWS KMS in `@typesys/kms-aws`. |
| [0038](adr/0038-authorization-planning.md) | Authorization planning: a read policy becomes a sound over-approximating plan — exact or not, with structured limitations — pushed into the adapter's filter and, when exact, admitting aggregation over exactly the readable rows; the post-read check stays; `rowSecurity: "require-exact"` and `explainQuery`. |
| [0039](adr/0039-cedar-partial-evaluation-planner.md) | Cedar planning: partial evaluation with the resource unknown, residuals translated by shape and weakened to `true` where they can't be, exact on attribute-bearing Types only under a `schemaConformantData` assertion; `anyOf` no longer lets a throwing alternative end the OR. |
| [0040](adr/0040-adapter-filter-capabilities-and-sql-pushdown.md) | Adapter filter capabilities and SQL pushdown: `canFilter` says what an adapter evaluates exactly (encrypted deterministic fields through the blind index); the Postgres adapter compiles filters to parameterized SQL, exact or a JavaScript-re-checked superset, paging in SQL when exact. |
| [0041](adr/0041-security-labels-v2.md) | Security labels v2: schemes `decide({ subject, markings, context })` and `join(markings)`; the runtime decides the join and every marking on its own, so a join only adds restriction; a reference `securityLabels` scheme with levels, compartments, releasability, CUI as its own regime, and accreditation. |
