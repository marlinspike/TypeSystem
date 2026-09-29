# How Complete Is This?

An honest inventory, kept up to date as the codebase changes — the
architecture and its contracts are complete; the implementation is a
proven, extending vertical slice, not a finished platform.

This page answers "what's built and tested versus a documented extension
point" for the architecture *as it exists*. Whether it is safe to run
against real production traffic is a different question. For that, see
[`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md), the ranked list of
what closing that gap would actually take (a real policy engine, a
threat model, production-scale load numbers, and more), and
[ADR-0024](adr/0024-production-readiness-gap.md) for the decision to
document that gap rather than close it in this pass.

## Fully built, tested, and demonstrated

- Meta-model + registry: Type/Relationship/Action/Policy/DataSource/Mapping,
  `extends` + trait composition, semver versioning with a real alias/
  deprecation transition test.
- Runtime: object retrieval, relationship navigation (concurrent, not
  N+1 — see [ADR](adr/) history), structured query, provenance (including
  aggregation for computed properties), Action invocation — all policy-
  and audit-gated in one place.
- Three adapter styles proven substitutable behind an identical interface:
  in-memory repo, mocked external REST, and a real PostgreSQL-backed
  adapter (`@typesys/adapter-postgres`) — object retrieval, filtered
  queries, and both relationship conventions proven against actual rows,
  not mocks. All three combine pairwise, not just individually: a real
  PostgreSQL-backed `Widget` with a relationship *and* a per-property
  Mapping override both resolving through a different, real
  `InMemoryRepositoryAdapter` (`packages/adapter-postgres/test/cross-adapter-composition.test.ts`).
- Two independent domains, both real code: `domain-airforce` and
  `domain-hospital` (Patient/Provider/Appointment), the latter proving
  domain-neutrality (ADR-0013) end-to-end — real relationship resolution
  (`byForeignKey`/`byOwnField`), `extends core.Person` composition,
  object/property policy boundaries, and a real MCP connection browsing
  it with zero changes to `resources.ts`/`tools.ts`.
- All three ways to combine data from multiple sources into one object
  graph/object are real and tested, not just modeled: relationships
  crossing adapters (ADR-0006), a computed property deriving its value
  from a second adapter it has no direct Mapping to
  (`Aircraft.needsAttention`, ADR-0022), and per-property Mapping
  overrides merging a Type's own fields from several DataSources into
  one `getObject`/`query` read (ADR-0023). See
  [`docs/how-to/combine-multiple-sources.md`](how-to/combine-multiple-sources.md).
- A production PostgreSQL `RegistryStore` — real migrations, an
  append-only audit table enforced by a DB trigger, keyset-paginated
  audit queries, a `BindingRegistry` seam for the behavior a database can
  never store (ADR-0015).
- A TTL-based cache for `resolutionMode: "cached"` properties,
  relationships, and computed properties, opt-in per mapping, with a
  manual `invalidateObject` escape hatch (ADR-0016).
- Bounded-concurrency fan-out for every relationship/query/provenance
  resolution (a large relationship or query page can no longer open
  unlimited simultaneous adapter calls), plus an opt-in per-identity
  token-bucket `RateLimiter` checked once at every public runtime entry
  point (ADR-0019).
- Input validation at the runtime boundary: `query` is checked against
  `semanticQuerySchema` and `QueryLimits` (default page 100, max 1000,
  bounded include count/depth and filter depth/size), and `invokeAction` input
  against each Action's `inputSchema`, all throwing `InvalidInputError`
  (`packages/core/src/runtime/input-validation.ts`). The MCP `query` tool
  advertises the same schema.
- Multi-instance deployment (ADR-0025): `@typesys/redis`'s `RedisCache`
  and `RedisRateLimiter` share cache entries, invalidation, and
  per-identity budgets across replicas; migrations serialize on a
  Postgres advisory lock. Proven by tests with two runtimes on one Redis
  and several registries on one Postgres, and by `npm run load-test`,
  which CI runs with two processes sharing Redis.
- One concurrency budget per request: `maxConcurrency` caps the adapter
  calls of a whole top-level call, nested fan-out and computed properties
  included, rather than each fan-out level separately (ADR-0025).
- Deployment artifacts (ADR-0029): `/healthz` and `/readyz` on the HTTP
  transport (covered by `packages/mcp-server/test/http-health.test.ts`), a
  multi-stage `Dockerfile`, a `docker-compose.yml` (Postgres + Redis + one-shot
  migration + N app replicas + nginx), and reference Kubernetes manifests
  (`deploy/k8s/`) with probes and a migration `Job`. The container/compose/k8s
  files are inspected reference artifacts — correct and runnable, but not built
  or run in CI, and not production-hardened (image scanning, secrets, TLS
  remain `PRODUCTION-READINESS.md` items).
- Adapter-call resilience (ADR-0026): an opt-in per-call timeout with
  cooperative `AbortSignal` cancellation, retries with exponential backoff
  and jitter for idempotent reads (and only Actions whose `idempotency` is
  not `"none"`), and a per-data-source circuit breaker — all wired once into
  `SemanticRuntime.getAdapter` and off by default. The mock-REST adapter
  honors the signal on its simulated latency; the Postgres pool's default
  `max` is aligned to the concurrency budget, with an opt-in
  `PG_STATEMENT_TIMEOUT_MS` (`packages/core/test/resilience.test.ts`).
- Type-aware ESLint (`typescript-eslint` `recommendedTypeChecked`) and a
  full type-check of source, tests, and scripts (`npm run typecheck`),
  both enforced in CI, run from an isolated `tools/eslint` toolchain
  because TypeScript 7 ships no JS API for the parser.
- OpenTelemetry tracing/metrics that cost nothing unless an application
  registers a real SDK — verified both directions (ADR-0017).
- MCP server on the real SDK, stateless per-call identity, proving the
  human and AI-agent paths get identical governance. Two real transports:
  stdio (`bin.ts`) and Streamable HTTP (`bin-http.ts`/`createHttpApp`,
  ADR-0021), the latter resolving identity from a real `Authorization`
  header, verified by a real HTTP-client smoke test
  (`npm run smoke:mcp-http`) alongside the stdio one.
- Real OIDC/JWT identity resolution (`@typesys/auth-oidc`) — signature,
  issuer (RFC 9207), audience, and expiry verified via `jose`, scope
  claims mapped per RFC 9396, drop-in replacement for `mcp-server`'s
  demo token map via the same `IdentityResolver` parameter (ADR-0018).
- A declarative YAML authoring path + `generate-types` codegen +
  `typesys init` scaffolding (`@typesys/cli`) — proven by actually
  compiling generated output with `tsc --strict`.
- The web demo makes all of the above clickable.
- CI (`.github/workflows/ci.yml`) builds and runs the full suite on
  every push, including a Postgres-service-container job for the
  database-gated tests.
- A latency/throughput benchmark (`npm run benchmark`) for
  `SemanticRuntime` operations against both the in-memory and
  PostgreSQL adapters — regression tracking, not a deployment-specific
  throughput SLA.
- Real publish infrastructure (package metadata, LICENSE, changesets for
  coordinated cross-package versioning, a gated `.github/workflows/release.yml`) —
  proven by a real `npm pack --dry-run` per package and `npx changeset status`
  correctly proposing bumps across the dependency graph. No package has
  actually been published to npm; the release workflow's publish step is
  gated behind an `NPM_TOKEN` secret that is not configured in this
  repository, deliberately (ADR-0020).
- 100+ tests (Postgres-gated ones skip cleanly without a database
  configured) + a real stdio MCP smoke test, all green.

## Real but narrow — the mechanism exists, exercised once

- Property-level policy is exercised on several fields, not just the two
  demo-domain ones (`Aircraft.maintenanceStatus`, `Patient.medicalRecordNumber`):
  a dedicated suite (`packages/core/test/property-policy.test.ts`) covers role-
  and attribute-based (ABAC) property policies across getObject redaction,
  getProvenance denial, query projection, and fail-closed filtering, with
  partial per-caller visibility.
- The query DSL covers filter, sort, projection (`select`), pagination,
  relationship includes, grouped aggregation (`runtime.aggregate()` + the MCP
  `aggregate` tool), and case-insensitive `search` / `icontains` — all
  fail-closed under property-level policy (ADR-0027, `query-sort-and-projection.test.ts`,
  `query-aggregate-and-search.test.ts`). A top-level filter or sort can't use a
  computed property (rejected with a clear error; they don't exist until after
  the adapter runs), but include filters can; includes nest, filter, and project
  per level (bounded by `maxIncludes`/`maxIncludeDepth`). Aggregation runs in the
  adapter's optional `aggregate` (in-memory and Postgres); a data source without
  it returns a clear `AggregationNotSupportedError`. Full-text `search` desugars
  to a uniform `icontains` substring match — native per-backend FTS (Postgres
  `to_tsvector`) is a documented per-adapter enhancement, not yet built.
- Relationship resolution is a small closed set of strategies parsed by the
  shared `parseResolution` (ADR-0028): `byForeignKey`, `byOwnField`,
  many-to-many `byJoinTable` (same-source join collection), and multi-field
  `byCompositeKey`. All three adapters consume the parsed form; the runtime
  caps fan-out at `maxRelatedPerObject` and includes take `sort` / `limit`. A
  cross-data-source join table is parsed but not yet resolved (an adapter that
  doesn't own the join throws `UnsupportedResolutionError`) — still not a
  general graph-join engine, by design (ADR-0003).
- Caching is wired and tested in isolation; the shipped demo domain
  doesn't turn it on for any real mapping (opt-in by design, per
  ADR-0016 — nothing stops you from setting `resolutionMode: "cached"`
  on your own).

## Documented as a seam, not (yet) implemented — the ADRs say this outright

- `resolutionMode: "materialized"` is supported by the model, but nothing
  populates a materialized store — there is no ingestion pipeline.
- The policy engine is a small embedded ABAC evaluator, not OPA/Cedar.
- Adapter-level tracing (a span per individual adapter call, not just
  the runtime method that contains it) is deferred — see ADR-0017's
  "Alternatives Considered."

## Correctly not built

Graph database, ETL platform, full IAM, a real policy engine, reactive
event propagation, GraphQL, an LLM orchestration layer — all explicit
non-goals in the original mission brief
([`docs/initial_prompt.md`](initial_prompt.md)), and the architecture
leaves clean extension points for each rather than stubbing them out.

## The pattern, if you're deciding whether to extend something here

Every "documented as a seam" item above follows the same shape: a small
interface (`Cache`, `PolicyEngine`, `RegistryStore`, `Adapter`) with one
built implementation and a clear place a second, more capable one would
slot in without touching `SemanticRuntime`. If you need one of these
seams filled in for real, that's usually a contained, well-bounded piece
of work — read the matching ADR's "Alternatives Considered" section
first; it likely already named the tradeoff you're about to make.
