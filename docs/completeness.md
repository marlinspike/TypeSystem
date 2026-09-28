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
- Two adapter styles proven substitutable behind an identical interface
  (in-memory repo + mocked external REST).
- A production PostgreSQL `RegistryStore` — real migrations, an
  append-only audit table enforced by a DB trigger, keyset-paginated
  audit queries, a `BindingRegistry` seam for the behavior a database can
  never store (ADR-0015).
- A TTL-based cache for `resolutionMode: "cached"` properties,
  relationships, and computed properties, opt-in per mapping, with a
  manual `invalidateObject` escape hatch (ADR-0016).
- OpenTelemetry tracing/metrics that cost nothing unless an application
  registers a real SDK — verified both directions (ADR-0017).
- MCP server on the real SDK, stateless per-call identity, proving the
  human and AI-agent paths get identical governance.
- A declarative YAML authoring path + `generate-types` codegen +
  `typesys init` scaffolding (`@typesys/cli`) — proven by actually
  compiling generated output with `tsc --strict`.
- The web demo makes all of the above clickable.
- 90+ tests (Postgres-gated ones skip cleanly without a database
  configured) + a real stdio MCP smoke test, all green.

## Real but narrow — the mechanism exists, exercised once

- One full domain package (`domain-airforce`); a second (Hospital) is a
  documented walkthrough, not actual code.
- Property-level policy is demonstrated on one field
  (`Aircraft.maintenanceStatus`).
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
- Auth is a static demo-token map
  (`packages/mcp-server/src/auth.ts`), not real OIDC/JWKS/RFC 9207/9396.
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
