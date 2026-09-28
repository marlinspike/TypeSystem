# How Complete Is This?

An honest inventory, kept up to date as the codebase changes — the
architecture and its contracts are complete; the implementation is a
proven, extending vertical slice, not a finished platform.

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
  not mocks.
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

- Property-level policy is demonstrated on two fields across two domains
  (`Aircraft.maintenanceStatus`, `Patient.medicalRecordNumber`).
- The query DSL covers filter/include/limit — no aggregation, sort, or
  full-text search.
- Relationship resolution is one convention (`byForeignKey:<field>`,
  `byOwnField:<field>`), not a general join mechanism.
- Caching is wired and tested in isolation; the shipped demo domain
  doesn't turn it on for any real mapping (opt-in by design, per
  ADR-0016 — nothing stops you from setting `resolutionMode: "cached"`
  on your own).

## Documented as a seam, not (yet) implemented — the ADRs say this outright

- `resolutionMode: "materialized"` is supported by the model, but nothing
  populates a materialized store — there is no ingestion pipeline.
- The policy engine is a small embedded ABAC evaluator, not OPA/Cedar.
- No distributed cache — `InMemoryCache` is per-process; a Redis-backed
  `Cache` implementation is a documented, not-built extension point,
  same shape of decision as `RegistryStore` before Postgres existed.
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
